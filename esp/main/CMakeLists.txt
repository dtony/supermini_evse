idf_component_register(SRCS "gap.c" "gatt_svr.c" "main.c"
                    INCLUDE_DIRS "."
                    REQUIRES esp_adc esp_driver_ledc app_update bt nvs_flash esp_timer)