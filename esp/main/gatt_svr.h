#pragma once

#include "esp_ota_ops.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define LOG_TAG_GATT_SVR "gatt_svr"
#define REBOOT_DEEP_SLEEP_TIMEOUT 500
#define GATT_DEVICE_INFO_UUID 0x180A
#define GATT_MANUFACTURER_NAME_UUID 0x2A29
#define GATT_MODEL_NUMBER_UUID 0x2A24

typedef enum {
  SVR_CHR_OTA_CONTROL_NOP,
  SVR_CHR_OTA_CONTROL_REQUEST,
  SVR_CHR_OTA_CONTROL_REQUEST_ACK,
  SVR_CHR_OTA_CONTROL_REQUEST_NAK,
  SVR_CHR_OTA_CONTROL_DONE,
  SVR_CHR_OTA_CONTROL_DONE_ACK,
  SVR_CHR_OTA_CONTROL_DONE_NAK,
} svr_chr_ota_control_val_t;

// service: OTA Service
// d6f1d96d-594c-4c53-b1c6-244a1dfde6d8
static const ble_uuid128_t gatt_svr_svc_ota_uuid =
    BLE_UUID128_INIT(0xd8, 0xe6, 0xfd, 0x1d, 0x4a, 024, 0xc6, 0xb1, 0x53, 0x4c,
                     0x4c, 0x59, 0x6d, 0xd9, 0xf1, 0xd6);

// characteristic: OTA Control
// 7ad671aa-21c0-46a4-b722-270e3ae3d830
static const ble_uuid128_t gatt_svr_chr_ota_control_uuid =
    BLE_UUID128_INIT(0x30, 0xd8, 0xe3, 0x3a, 0x0e, 0x27, 0x22, 0xb7, 0xa4, 0x46,
                     0xc0, 0x21, 0xaa, 0x71, 0xd6, 0x7a);

// characteristic: OTA Data
// 23408888-1f40-4cd8-9b89-ca8d45f8a5b0
static const ble_uuid128_t gatt_svr_chr_ota_data_uuid =
    BLE_UUID128_INIT(0xb0, 0xa5, 0xf8, 0x45, 0x8d, 0xca, 0x89, 0x9b, 0xd8, 0x4c,
                     0x40, 0x1f, 0x88, 0x88, 0x40, 0x23);

// service: EVSE Control Service
// de8305b5-4e28-4953-8eee-b81e7fa03e39
static const ble_uuid128_t gatt_svr_svc_evse_uuid =
    BLE_UUID128_INIT(0x39, 0x3e, 0xa0, 0x7f, 0x1e, 0xb8, 0xee, 0x8e, 0x53, 0x49,
                     0x28, 0x4e, 0xb5, 0x05, 0x83, 0xde);

// characteristic: Current Amp
// 594fdcf8-aa5f-4a05-9ecd-5777c57d700c
static const ble_uuid128_t gatt_svr_chr_current_amp_uuid =
    BLE_UUID128_INIT(0x0c, 0x70, 0x7d, 0xc5, 0x77, 0x57, 0xcd, 0x9e, 0x05, 0x4a,
                     0x5f, 0xaa, 0xf8, 0xdc, 0x4f, 0x59);

extern uint8_t current_amp;
void cp_pwm_update(uint8_t amp);

void gatt_svr_init();