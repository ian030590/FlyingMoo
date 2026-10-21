/**
 * @file tgi_bridge.h
 * Thin C ABI bridge interface for Tobii Game Integration (TGI) C++ API.
 * Exposes pure C calling conventions to Rust FFI without C++ ABI coupling.
 */

#ifndef FLYINGMOO_TGI_BRIDGE_H
#define FLYINGMOO_TGI_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Status codes
#define TGI_STATUS_OK 0
#define TGI_STATUS_NOT_INITIALIZED 1
#define TGI_STATUS_RUNTIME_UNAVAILABLE 2
#define TGI_STATUS_DEVICE_ABSENT 3
#define TGI_STATUS_TRACKING_LOST 4
#define TGI_STATUS_NO_NEW_DATA 5
#define TGI_STATUS_ERROR -1

/**
 * Open Tobii Game Integration instance with window HWND.
 * @param hwnd Pointer to main window handle.
 * @param sdk_path Optional explicit directory containing Tobii DLLs.
 * @return TGI_STATUS_OK on success, or error status code.
 */
int32_t tgi_bridge_open(void* hwnd, const char* sdk_path);

/**
 * Pump TGI event loop and poll latest head pose.
 * @return TGI_STATUS_OK on success, or status code.
 */
int32_t tgi_bridge_update(void);

/**
 * Retrieve latest head pose from internal snapshot.
 * @param out_yaw_deg Pointer to output yaw in degrees (positive right).
 * @param out_pitch_deg Pointer to output pitch in degrees (positive up).
 * @param out_roll_deg Pointer to output roll in degrees.
 * @param out_timestamp_us Pointer to output timestamp in microseconds.
 * @param out_is_valid Pointer to output boolean validity flag (1 = valid, 0 = invalid).
 * @return TGI_STATUS_OK if new data available, TGI_STATUS_NO_NEW_DATA if unchanged, or error.
 */
int32_t tgi_bridge_get_latest_head_pose(
    float* out_yaw_deg,
    float* out_pitch_deg,
    float* out_roll_deg,
    int64_t* out_timestamp_us,
    int32_t* out_is_valid
);

/**
 * Get current bridge status.
 * @return Status code enum.
 */
int32_t tgi_bridge_get_status(void);

/**
 * Shutdown TGI and release all resources.
 */
void tgi_bridge_close(void);

#ifdef __cplusplus
}
#endif

#endif // FLYINGMOO_TGI_BRIDGE_H
