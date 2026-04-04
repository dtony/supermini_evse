#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gap.h"
#include "gatt_svr.h"
#include "nvs_flash.h"
#include "store/config/ble_store_config.h"

#define LOG_TAG_MAIN "main"

/* GPIO used to monitor an incoming PWM signal */
#define PWM_MONITOR_GPIO 7

#define CP_PWM_GPIO       4
#define CP_PWM_FREQ_HZ    1000
#define CP_PWM_TIMER      LEDC_TIMER_0
#define CP_PWM_CHANNEL    LEDC_CHANNEL_0
#define CP_PWM_MODE       LEDC_LOW_SPEED_MODE
#define CP_PWM_RESOLUTION LEDC_TIMER_10_BIT

uint8_t current_amp = 6;

/* ---- PWM monitor --------------------------------------------------------- */

#define PWM_MONITOR_TAG        "pwm_mon"
#define PWM_MONITOR_TIMEOUT_US 50000LL /* 50 ms – signal absent if no edge seen */

static portMUX_TYPE         pwm_mux        = portMUX_INITIALIZER_UNLOCKED;
static volatile int64_t     pwm_rise_us    = 0; /* timestamp of last rising edge  */
static volatile int64_t     pwm_period_us  = 0; /* measured period                */
static volatile int64_t     pwm_high_us    = 0; /* measured high-time             */
/* Set to true when a valid PWM (500-2 kHz, 5-90 % duty) is detected; never cleared */
static volatile bool        pwm_signal_valid = false;

static void IRAM_ATTR pwm_gpio_isr(void *arg)
{
    int64_t now   = esp_timer_get_time();
    int     level = gpio_get_level(PWM_MONITOR_GPIO);

    portENTER_CRITICAL_ISR(&pwm_mux);
    if (level == 1) {
        /* Rising edge: compute period from the previous rising edge */
        if (pwm_rise_us > 0) {
            pwm_period_us = now - pwm_rise_us;
        }
        pwm_rise_us = now;
    } else {
        /* Falling edge: compute high-time from the last rising edge */
        if (pwm_rise_us > 0) {
            pwm_high_us = now - pwm_rise_us;
        }
    }
    portEXIT_CRITICAL_ISR(&pwm_mux);
}

static void pwm_monitor_task(void *arg)
{
    /* Configure GPIO as input with interrupt on every edge */
    gpio_config_t io_conf = {
        .intr_type    = GPIO_INTR_ANYEDGE,
        .mode         = GPIO_MODE_INPUT,
        .pin_bit_mask = (1ULL << PWM_MONITOR_GPIO),
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io_conf));

    /* Install shared ISR service (safe to call even if already installed) */
    esp_err_t isr_err = gpio_install_isr_service(0);
    if (isr_err != ESP_OK && isr_err != ESP_ERR_INVALID_STATE) {
        ESP_ERROR_CHECK(isr_err);
    }
    ESP_ERROR_CHECK(gpio_isr_handler_add(PWM_MONITOR_GPIO, pwm_gpio_isr, NULL));

    ESP_LOGI(PWM_MONITOR_TAG, "Monitoring PWM on GPIO%d", PWM_MONITOR_GPIO);

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        /* Snapshot shared state inside a critical section */
        int64_t rise, period, high;
        portENTER_CRITICAL(&pwm_mux);
        rise   = pwm_rise_us;
        period = pwm_period_us;
        high   = pwm_high_us;
        portEXIT_CRITICAL(&pwm_mux);

        int64_t now           = esp_timer_get_time();
        bool    signal_present = (rise > 0) && ((now - rise) < PWM_MONITOR_TIMEOUT_US);

        if (!signal_present) {
            ESP_LOGI(PWM_MONITOR_TAG, "GPIO%d: no PWM signal detected",
                     PWM_MONITOR_GPIO);
        } else if (period <= 0) {
            ESP_LOGI(PWM_MONITOR_TAG, "GPIO%d: PWM signal detected (measuring...)",
                     PWM_MONITOR_GPIO);
        } else {
            float freq_hz  = 1000000.0f / (float)period;
            float duty_pct = (float)high * 100.0f / (float)period;
            if (!pwm_signal_valid &&
                freq_hz >= 500.0f && freq_hz <= 2000.0f &&
                duty_pct >= 5.0f  && duty_pct <= 90.0f) {
                pwm_signal_valid = true;
            }
            ESP_LOGI(PWM_MONITOR_TAG,
                     "GPIO%d: PWM detected – freq=%.1f Hz, duty=%.1f%% [valid=%s]",
                     PWM_MONITOR_GPIO, freq_hz, duty_pct,
                     pwm_signal_valid ? "yes" : "no");
        }
    }
}

static uint32_t amp_to_duty(uint8_t amp) {
  if (amp == 0) {
    return 0;
  }
  uint32_t duty_us;
  if (amp <= 51) {
    // SAE J1772: duty_us = amp / 0.6 * 10 = amp * 100 / 6
    duty_us = (uint32_t)amp * 100 / 6;
  } else {
    // SAE J1772: duty_us = ((amp - 640/4) / 2.5) * 10, rearranged: amp * 4 + 640
    duty_us = (uint32_t)amp * 4 + 640;
  }
  // Convert duty_us (0–1000 μs) to LEDC duty (0 to 2^10 - 1 = 1023)
  return (duty_us * 1023u) / 1000u;
}

static void cp_pwm_init(void) {
  ledc_timer_config_t timer_cfg = {
      .speed_mode      = CP_PWM_MODE,
      .timer_num       = CP_PWM_TIMER,
      .duty_resolution = CP_PWM_RESOLUTION,
      .freq_hz         = CP_PWM_FREQ_HZ,
      .clk_cfg         = LEDC_AUTO_CLK,
  };
  ESP_ERROR_CHECK(ledc_timer_config(&timer_cfg));

  ledc_channel_config_t channel_cfg = {
      .gpio_num   = CP_PWM_GPIO,
      .speed_mode = CP_PWM_MODE,
      .channel    = CP_PWM_CHANNEL,
      .timer_sel  = CP_PWM_TIMER,
      .duty       = amp_to_duty(current_amp),
      .hpoint     = 0,
  };
  ESP_ERROR_CHECK(ledc_channel_config(&channel_cfg));
}

void cp_pwm_update(uint8_t amp) {
  uint32_t duty = amp_to_duty(amp);
  ESP_LOGI(LOG_TAG_MAIN, "cp_pwm_update: amp=%d duty=%lu", amp, duty);
  esp_err_t err = ledc_set_duty(CP_PWM_MODE, CP_PWM_CHANNEL, duty);
  if (err != ESP_OK) {
    ESP_LOGE(LOG_TAG_MAIN, "ledc_set_duty failed: %s", esp_err_to_name(err));
    return;
  }
  err = ledc_update_duty(CP_PWM_MODE, CP_PWM_CHANNEL);
  if (err != ESP_OK) {
    ESP_LOGE(LOG_TAG_MAIN, "ledc_update_duty failed: %s", esp_err_to_name(err));
  }
}

bool run_diagnostics() {
  // do some diagnostics
  return true;
}

void app_main(void) {
  /* Start PWM monitor first, then wait 5 s before deciding whether to init CP PWM */
  xTaskCreate(pwm_monitor_task, "pwm_monitor", 4096, NULL, 5, NULL);

  vTaskDelay(pdMS_TO_TICKS(5000));

  if (!pwm_signal_valid) {
    cp_pwm_init();
  } else {
    ESP_LOGI(LOG_TAG_MAIN, "Valid PWM detected on GPIO%d – skipping CP PWM init",
             PWM_MONITOR_GPIO);
  }

  // check which partition is running
  const esp_partition_t *partition = esp_ota_get_running_partition();

  switch (partition->address) {
    case 0x00010000:
      ESP_LOGI(LOG_TAG_MAIN, "Running partition: factory");
      break;
    case 0x00110000:
      ESP_LOGI(LOG_TAG_MAIN, "Running partition: ota_0");
      break;
    case 0x00210000:
      ESP_LOGI(LOG_TAG_MAIN, "Running partition: ota_1");
      break;

    default:
      ESP_LOGE(LOG_TAG_MAIN, "Running partition: unknown");
      break;
  }

  // check if an OTA has been done, if so run diagnostics
  esp_ota_img_states_t ota_state;
  if (esp_ota_get_state_partition(partition, &ota_state) == ESP_OK) {
    if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
      ESP_LOGI(LOG_TAG_MAIN, "An OTA update has been detected.");
      if (run_diagnostics()) {
        ESP_LOGI(LOG_TAG_MAIN,
                 "Diagnostics completed successfully! Continuing execution.");
        esp_ota_mark_app_valid_cancel_rollback();
      } else {
        ESP_LOGE(LOG_TAG_MAIN,
                 "Diagnostics failed! Start rollback to the previous version.");
        esp_ota_mark_app_invalid_rollback_and_reboot();
      }
    }
  }

  ESP_LOGI(LOG_TAG_MAIN, "This is version 1.");

  // Initialize NVS
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
      ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  // BLE Setup

  // initialize BLE controller and nimble stack
  nimble_port_init();

  // register sync and reset callbacks
  ble_hs_cfg.sync_cb = sync_cb;
  ble_hs_cfg.reset_cb = reset_cb;

  // security: mode 1, level 4 – authenticated LE Secure Connections
  ble_hs_cfg.sm_io_cap       = BLE_HS_IO_DISPLAY_ONLY;
  ble_hs_cfg.sm_sc           = 1; // LE Secure Connections (required for level 4)
  ble_hs_cfg.sm_mitm         = 1; // require MITM protection
  ble_hs_cfg.sm_bonding      = 1; // exchange and store LTK so keys survive reboot
  // distribute LTK + IRK in both directions so the peer's resolvable private
  // address can be resolved on reconnect (prevents re-pairing after reboot)
  ble_hs_cfg.sm_our_key_dist   = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

  // initialize service table
  gatt_svr_init();

  // initialize NVS-backed bond store so pairing info survives reboots
  ble_hs_cfg.store_read_cb   = ble_store_config_read;
  ble_hs_cfg.store_write_cb  = ble_store_config_write;
  ble_hs_cfg.store_delete_cb = ble_store_config_delete;

  // set device name and start host task
  ble_svc_gap_device_name_set(device_name);
  nimble_port_freertos_init(host_task);
}