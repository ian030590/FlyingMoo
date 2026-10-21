/**
 * @file tgi_bridge.cpp
 * Implementation of thin C ABI bridge for Tobii Game Integration (TGI).
 * Wraps C++ SDK objects and prevents exceptions from unwinding across FFI boundary.
 */

#include "tgi_bridge.h"
#include <chrono>
#include <atomic>
#include <cstring>

static std::atomic<int32_t> g_status(TGI_STATUS_NOT_INITIALIZED);
static std::atomic<int64_t> g_last_timestamp(0);
static float g_yaw = 0.0f;
static float g_pitch = 0.0f;
static float g_roll = 0.0f;
static int32_t g_valid = 0;

int32_t tgi_bridge_open(void* hwnd, const char* sdk_path) {
    (void)hwnd;
    (void)sdk_path;
    // The SDK is not integrated; callers must not treat this bridge as connected.
    g_status.store(TGI_STATUS_RUNTIME_UNAVAILABLE);
    return TGI_STATUS_RUNTIME_UNAVAILABLE;
}

int32_t tgi_bridge_update(void) {
    if (g_status.load() == TGI_STATUS_NOT_INITIALIZED) {
        return TGI_STATUS_NOT_INITIALIZED;
    }
    return g_status.load();
}

int32_t tgi_bridge_get_latest_head_pose(
    float* out_yaw_deg,
    float* out_pitch_deg,
    float* out_roll_deg,
    int64_t* out_timestamp_us,
    int32_t* out_is_valid
) {
    if (g_status.load() != TGI_STATUS_OK) {
        if (out_is_valid) *out_is_valid = 0;
        return g_status.load();
    }

    if (out_yaw_deg) *out_yaw_deg = g_yaw;
    if (out_pitch_deg) *out_pitch_deg = g_pitch;
    if (out_roll_deg) *out_roll_deg = g_roll;
    if (out_timestamp_us) *out_timestamp_us = g_last_timestamp.load();
    if (out_is_valid) *out_is_valid = g_valid;

    return TGI_STATUS_OK;
}

int32_t tgi_bridge_get_status(void) {
    return g_status.load();
}

void tgi_bridge_close(void) {
    g_status.store(TGI_STATUS_NOT_INITIALIZED);
    g_valid = 0;
}
