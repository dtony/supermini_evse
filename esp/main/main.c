#include "driver/ledc.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_continuous.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gap.h"
#include "gatt_svr.h"
#include "nvs_flash.h"
#include "store/config/ble_store_config.h"
#include <inttypes.h>
#include "version.h"

#define LOG_TAG_MAIN "main"

/* GPIO used to monitor an incoming PWM signal.
 * Must be an ADC-capable pin: on ESP32-C3, ADC1 covers GPIO0–GPIO5 only.
 * GPIO3 = ADC1_CH3 is used here. */
// #define PWM_MONITOR_GPIO 3

/* GPIO used to generate the CP PWM signal */
#define CP_PWM_GPIO       4
#define CP_PWM_FREQ_HZ    1000
#define CP_PWM_TIMER      LEDC_TIMER_0
#define CP_PWM_CHANNEL    LEDC_CHANNEL_0
#define CP_PWM_MODE       LEDC_LOW_SPEED_MODE
#define CP_PWM_RESOLUTION LEDC_TIMER_10_BIT

uint8_t current_amp = 0;
int16_t pwm_cal_offset_us = 0;
uint32_t ble_passkey = 0;

/* ---- PWM monitor (continuous ADC / DMA) ---------------------------------- */

#define PWM_MONITOR_TAG             "pwm_mon"
#define PWM_MONITOR_ADC_UNIT        ADC_UNIT_1
#define PWM_MONITOR_ADC_CHANNEL     ADC_CHANNEL_3   /* GPIO3 = ADC1_CH3 on ESP32-C3 */
#define PWM_MONITOR_ADC_ATTEN       ADC_ATTEN_DB_12 /* 0–3.3 V input range */
#define PWM_MONITOR_SAMPLE_FREQ_HZ  40000           /* 40 kS/s → 20+ samples/cycle at 2 kHz */
#define PWM_MONITOR_FRAME_SIZE      512             /* bytes per DMA frame (128 samples × 4 B) */
#define PWM_MONITOR_BUF_SIZE        (PWM_MONITOR_FRAME_SIZE * 4)

/* Voltage divider in front of GPIO3: R1=68 kΩ (series), R2=22 kΩ (shunt to GND).
 * Signal also passes through a 1N4148WS diode (Vf ≈ 0.7 V) before the ADC pin. */
#define CP_DIVIDER_R1_K             68.0f
#define CP_DIVIDER_R2_K             22.0f
#define CP_DIVIDER_FACTOR           ((CP_DIVIDER_R1_K + CP_DIVIDER_R2_K) / CP_DIVIDER_R2_K) /* ≈ 4.09 */
#define DIODE_1N4148WS_VF_MV        700   /* 1N4148WS forward voltage drop ≈ 0.7 V */
#define DIODE_CONDUCTING_THRESH_RAW 100   /* ADC raw noise floor; above = diode conducting */
#define SIGNAL_DETECT_THRESHOLD_MV  3000

/* Set to true when a valid PWM (500–2 kHz, 5–90 % duty) is detected; never cleared */
static volatile bool pwm_signal_valid = false;

static void pwm_monitor_task(void *arg)
{
    /* ---- Initialise ADC continuous (DMA) driver ---- */
    adc_continuous_handle_t adc_handle = NULL;
    adc_continuous_handle_cfg_t handle_cfg = {
        .max_store_buf_size = PWM_MONITOR_BUF_SIZE,
        .conv_frame_size    = PWM_MONITOR_FRAME_SIZE,
    };
    ESP_ERROR_CHECK(adc_continuous_new_handle(&handle_cfg, &adc_handle));

    adc_digi_pattern_config_t pattern = {
        .atten     = PWM_MONITOR_ADC_ATTEN,
        .channel   = PWM_MONITOR_ADC_CHANNEL,
        .unit      = PWM_MONITOR_ADC_UNIT,
        .bit_width = ADC_BITWIDTH_12,
    };
    adc_continuous_config_t cont_cfg = {
        .pattern_num    = 1,
        .adc_pattern    = &pattern,
        .sample_freq_hz = PWM_MONITOR_SAMPLE_FREQ_HZ,
        .conv_mode      = ADC_CONV_SINGLE_UNIT_1,
        .format         = ADC_DIGI_OUTPUT_FORMAT_TYPE2,
    };
    ESP_ERROR_CHECK(adc_continuous_config(adc_handle, &cont_cfg));

    /* ---- Initialise ADC calibration ---- */
    adc_cali_handle_t cali_handle = NULL;
    bool cali_ok = false;

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id  = PWM_MONITOR_ADC_UNIT,
        .atten    = PWM_MONITOR_ADC_ATTEN,
        .bitwidth = ADC_BITWIDTH_12,
    };
    cali_ok = (adc_cali_create_scheme_curve_fitting(&cali_cfg, &cali_handle) == ESP_OK);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cali_cfg = {
        .unit_id  = PWM_MONITOR_ADC_UNIT,
        .atten    = PWM_MONITOR_ADC_ATTEN,
        .bitwidth = ADC_BITWIDTH_12,
    };
    cali_ok = (adc_cali_create_scheme_line_fitting(&cali_cfg, &cali_handle) == ESP_OK);
#endif
    if (!cali_ok) {
        ESP_LOGW(PWM_MONITOR_TAG, "ADC calibration unavailable - raw mV reported");
    }

    ESP_ERROR_CHECK(adc_continuous_start(adc_handle));
    ESP_LOGI(PWM_MONITOR_TAG, "ADC continuous started on GPIO%d (ADC1_CH%d) @ %d S/s",
             ADC_CHANNEL_3, PWM_MONITOR_ADC_CHANNEL, PWM_MONITOR_SAMPLE_FREQ_HZ);

    /* ---- Per-second measurement accumulators ---- */
    static uint8_t              frame_buf[PWM_MONITOR_FRAME_SIZE];
    const int64_t               us_per_sample = 1000000LL / PWM_MONITOR_SAMPLE_FREQ_HZ;
    int64_t  last_report_us = esp_timer_get_time();
    bool     prev_high      = false;
    int64_t  last_rise_us   = 0;
    int64_t  period_sum_us   = 0;
    int64_t  high_sum_us    = 0;
    uint32_t period_count    = 0;
    int64_t  adc_sum_raw     = 0;   /* sum of every raw ADC reading this second */
    uint32_t n_conducting    = 0;   /* samples where diode is conducting (raw > noise floor) */
    uint32_t n_total_samples = 0;
    int      peak_raw        = 0;
    int      threshold_raw  = 2048; /* mid-scale starting point; updated each second */

    while (1) {
        uint32_t out_len = 0;
        esp_err_t ret = adc_continuous_read(adc_handle, frame_buf,
                                            PWM_MONITOR_FRAME_SIZE, &out_len, 100);
        if (ret != ESP_OK || out_len == 0) {
            continue;
        }

        int64_t  now_us         = esp_timer_get_time();
        uint32_t n_results      = out_len / sizeof(adc_digi_output_data_t);
        int64_t  frame_start_us = now_us - (int64_t)n_results * us_per_sample;
        adc_digi_output_data_t *results = (adc_digi_output_data_t *)(void *)frame_buf;

        for (uint32_t i = 0; i < n_results; i++) {
            int     raw       = (int)results[i].type2.data;
            int64_t sample_us = frame_start_us + (int64_t)i * us_per_sample;
            bool    high      = (raw > threshold_raw);

            /* Accumulate every sample for average voltage */
            adc_sum_raw += raw;
            n_total_samples++;
            if (raw > DIODE_CONDUCTING_THRESH_RAW) n_conducting++;

            if (high && !prev_high) {
                /* Rising edge – measure period */
                if (last_rise_us > 0) {
                    int64_t period = sample_us - last_rise_us;
                    if (period > 0 && period < 10000000LL) {
                        period_sum_us += period;
                        period_count++;
                    }
                }
                last_rise_us = sample_us;
                peak_raw     = raw;
            } else if (high) {
                /* Ongoing HIGH – track peak for threshold update */
                if (raw > peak_raw) peak_raw = raw;
            } else if (!high && prev_high) {
                /* Falling edge – accumulate high-time */
                if (last_rise_us > 0) {
                    high_sum_us += sample_us - last_rise_us;
                }
            }
            prev_high = high;
        }

        /* Report once per second */
        if ((now_us - last_report_us) < 1000000LL) {
            continue;
        }
        last_report_us = now_us;

        if (n_total_samples == 0) {
    #ifdef DEBUG
          ESP_LOGW(PWM_MONITOR_TAG, "GPIO%d: no ADC samples received this second", ADC_CHANNEL_3);
    #endif
        } else {
            /* ---- Voltage reconstruction (always, regardless of PWM detection) ---- */
            int avg_raw    = (int)(adc_sum_raw / (int64_t)n_total_samples);
            int avg_adc_mv = avg_raw; /* fallback if calibration unavailable */
            if (cali_ok) {
                adc_cali_raw_to_voltage(cali_handle, avg_raw, &avg_adc_mv);
            }
            int peak_adc_mv = peak_raw;
            if (cali_ok) {
                adc_cali_raw_to_voltage(cali_handle, peak_raw, &peak_adc_mv);
            }

            float vf_correction_mv = (float)DIODE_1N4148WS_VF_MV
                                     * ((float)n_conducting / (float)n_total_samples);
            float avg_div_mv    = (float)avg_adc_mv + vf_correction_mv;
            int32_t avg_original_mv = (int32_t)(avg_div_mv * CP_DIVIDER_FACTOR);

            if (!pwm_signal_valid && avg_original_mv > SIGNAL_DETECT_THRESHOLD_MV) {
                pwm_signal_valid = true;
            }

            ESP_LOGI(PWM_MONITOR_TAG,
                 "[VOLT] avg_original=%" PRId32 " mV (threshold=%d mV) valid=%s",
                 avg_original_mv, SIGNAL_DETECT_THRESHOLD_MV,
                 pwm_signal_valid ? "yes" : "no");

            /* ---- Frequency (only if edges were detected) ---- */
      #ifdef DEBUG
            if (period_count > 0) {
                float freq_hz = (float)period_count * 1e6f / (float)period_sum_us;
                ESP_LOGI(PWM_MONITOR_TAG,
                         "[PWM]  freq=%.1f Hz  periods=%lu",
                         freq_hz, (unsigned long)period_count);
            } else {
                ESP_LOGI(PWM_MONITOR_TAG, "[PWM]  no edges detected (threshold_raw=%d)", threshold_raw);
            }

            /* ---- ADC raw stats ---- */
            ESP_LOGI(PWM_MONITOR_TAG,
                     "[ADC]  avg_raw=%d  peak_raw=%d  threshold_raw=%d"
                     "  conducting=%lu/%lu (%.1f%%)",
                     avg_raw, peak_raw, threshold_raw,
                     (unsigned long)n_conducting, (unsigned long)n_total_samples,
                     100.0f * (float)n_conducting / (float)n_total_samples);

            /* ---- Voltage reconstruction steps ---- */
            ESP_LOGI(PWM_MONITOR_TAG,
                     "[VOLT] avg_adc=%.0f mV  +Vf_corr=%.0f mV  =>  avg_divider=%.0f mV"
                     "  =>  avg_original=%" PRId32 " mV  valid=%s",
                     (float)avg_adc_mv, vf_correction_mv, avg_div_mv,
                     avg_original_mv, pwm_signal_valid ? "yes" : "no");

            ESP_LOGI(PWM_MONITOR_TAG,
                     "[VOLT] peak_adc=%d mV  =>  peak_original=%.0f mV",
                     peak_adc_mv, (float)peak_adc_mv * CP_DIVIDER_FACTOR + (float)DIODE_1N4148WS_VF_MV * CP_DIVIDER_FACTOR);
      #endif

            /* Update threshold to 50 % of observed HIGH peak for next second */
            if (peak_raw > 0) {
                threshold_raw = peak_raw / 2;
            }
        }

        /* Reset per-second accumulators */
        period_sum_us   = 0;
        high_sum_us     = 0;
        period_count    = 0;
        adc_sum_raw     = 0;
        n_conducting    = 0;
        n_total_samples = 0;
        peak_raw        = 0;
    }

    /* Unreachable – clean up if ever reached */
    adc_continuous_stop(adc_handle);
    adc_continuous_deinit(adc_handle);
    if (cali_ok) {
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
        adc_cali_delete_scheme_curve_fitting(cali_handle);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
        adc_cali_delete_scheme_line_fitting(cali_handle);
#endif
    }
    vTaskDelete(NULL);
}

static uint32_t amp_to_duty(uint8_t amp) {
  if (amp == 0) {
    return 0;
  }
  int32_t duty_us;
  if (amp <= 51) {
    // SAE J1772: duty_us = amp / 0.6 * 10 = amp * 100 / 6
    duty_us = (int32_t)((uint32_t)amp * 100 / 6);
  } else {
    // SAE J1772: duty_us = ((amp - 640/4) / 2.5) * 10, rearranged: amp * 4 + 640
    duty_us = (int32_t)((uint32_t)amp * 4 + 640);
  }
  // Apply calibration offset
  duty_us -= (int32_t)pwm_cal_offset_us;
  if (duty_us < 0)    duty_us = 0;
  if (duty_us > 1000) duty_us = 1000;
  // Convert duty_us (0–1000 μs) to LEDC duty (0 to 2^10 - 1 = 1023)
  return ((uint32_t)duty_us * 1023u) / 1000u;
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

void pwm_cal_update(int16_t offset_us) {
  pwm_cal_offset_us = offset_us;
  nvs_handle_t nvs;
  if (nvs_open("evse", NVS_READWRITE, &nvs) == ESP_OK) {
    nvs_set_i16(nvs, "cal_offset", offset_us);
    nvs_commit(nvs);
    nvs_close(nvs);
  }
  cp_pwm_update(current_amp);
}

bool run_diagnostics() {
  // do some diagnostics
  return true;
}

void app_main(void) {
  cp_pwm_init();

  // Initialize NVS first so the calibration offset is available before cp_pwm_init
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
      ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  // Load calibration offset from NVS
  {
    nvs_handle_t cal_nvs;
    if (nvs_open("evse", NVS_READONLY, &cal_nvs) == ESP_OK) {
      int16_t saved_offset = 0;
      if (nvs_get_i16(cal_nvs, "cal_offset", &saved_offset) == ESP_OK) {
        pwm_cal_offset_us = saved_offset;
        ESP_LOGI(LOG_TAG_MAIN, "Loaded PWM cal offset: %d us", (int)saved_offset);
      }
      nvs_close(cal_nvs);
    }
  }

  /* Start PWM monitor first, then wait 5 s before deciding whether to init CP PWM */
  TaskHandle_t pwm_monitor_handle = NULL;
  xTaskCreate(pwm_monitor_task, "pwm_monitor", 4096, NULL, 5, &pwm_monitor_handle);

  vTaskDelay(pdMS_TO_TICKS(2000));

  if (pwm_signal_valid) {
  // if(true) { // test mode, simulate PWM detected
    if (pwm_monitor_handle != NULL) {
      vTaskDelete(pwm_monitor_handle);
      pwm_monitor_handle = NULL;
    }
    ESP_LOGI(LOG_TAG_MAIN, "Valid PWM detected on GPIO%d – skipping CP PWM init", ADC_CHANNEL_3);
  } else {
    if (pwm_monitor_handle != NULL) {
      vTaskDelete(pwm_monitor_handle);
      pwm_monitor_handle = NULL;
    }
    cp_pwm_update(6);
    ESP_LOGI(LOG_TAG_MAIN, "No valid PWM detected on GPIO%d – initializing CP PWM", ADC_CHANNEL_3);
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

  ESP_LOGI(LOG_TAG_MAIN, "This is version %s", FIRMWARE_REVISION_STRING);

  // Load or generate the BLE passkey from NVS
  nvs_handle_t passkey_nvs;
  esp_err_t pk_err = nvs_open("evse", NVS_READWRITE, &passkey_nvs);
  if (pk_err == ESP_OK) {
    pk_err = nvs_get_u32(passkey_nvs, "passkey", &ble_passkey);
    if (pk_err == ESP_ERR_NVS_NOT_FOUND) {
      ble_passkey = esp_random() % 1000000;
      nvs_set_u32(passkey_nvs, "passkey", ble_passkey);
      nvs_commit(passkey_nvs);
    }
    nvs_close(passkey_nvs);
  } else {
    ESP_LOGE(LOG_TAG_MAIN, "Failed to open NVS for passkey: %s", esp_err_to_name(pk_err));
    ble_passkey = esp_random() % 1000000;
  }
  ESP_LOGI(LOG_TAG_MAIN, "BLE passkey: %06" PRIu32, ble_passkey);

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