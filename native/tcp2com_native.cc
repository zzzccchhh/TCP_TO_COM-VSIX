// Node-API bridge for per-socket Windows Keepalive tuning. It only examines TCP
// handles in the current Node event loop and requires an exact endpoint match.
#include <node_api.h>
#include <uv.h>
#include <winsock2.h>
#include <mstcpip.h>
#include <string>

// Resolve Node/libuv exports from the current executable. This works with both
// node.exe and Electron's Code.exe without importing a separate node.exe DLL.
#define SYMBOLS(X) \
    X(napi_get_cb_info) X(napi_get_value_string_utf8) X(napi_get_value_int32) \
    X(napi_throw_type_error) X(napi_throw_error) X(napi_get_uv_event_loop) \
    X(napi_create_object) X(napi_get_boolean) X(napi_set_named_property) \
    X(napi_create_function) X(uv_is_closing) X(uv_tcp_getsockname) \
    X(uv_tcp_getpeername) X(uv_ip4_name) X(uv_fileno) X(uv_walk)
#define DECLARE(name) static decltype(&::name) fn_##name = nullptr;
SYMBOLS(DECLARE)
#undef DECLARE
static bool LoadSymbols() {
    HMODULE module = GetModuleHandleW(L"node.dll");
    if (!module) module = GetModuleHandleW(nullptr);
#define LOAD(name) fn_##name = reinterpret_cast<decltype(&::name)>(GetProcAddress(module, #name)); if (!fn_##name) return false;
    SYMBOLS(LOAD)
#undef LOAD
    return true;
}
#define napi_get_cb_info fn_napi_get_cb_info
#define napi_get_value_string_utf8 fn_napi_get_value_string_utf8
#define napi_get_value_int32 fn_napi_get_value_int32
#define napi_throw_type_error fn_napi_throw_type_error
#define napi_throw_error fn_napi_throw_error
#define napi_get_uv_event_loop fn_napi_get_uv_event_loop
#define napi_create_object fn_napi_create_object
#define napi_get_boolean fn_napi_get_boolean
#define napi_set_named_property fn_napi_set_named_property
#define napi_create_function fn_napi_create_function
#define uv_is_closing fn_uv_is_closing
#define uv_tcp_getsockname fn_uv_tcp_getsockname
#define uv_tcp_getpeername fn_uv_tcp_getpeername
#define uv_ip4_name fn_uv_ip4_name
#define uv_fileno fn_uv_fileno
#define uv_walk fn_uv_walk
#ifndef TCP_KEEPCNT
#define TCP_KEEPCNT 16
#endif

struct Tune {
    int local_port, remote_port, idle_ms, interval_ms, count;
    std::string local_ip, remote_ip;
    bool found = false, interval = false, probes = false;
};
static void Visit(uv_handle_t* handle, void* pointer) {
    auto* tune = static_cast<Tune*>(pointer);
    if (tune->found || handle->type != UV_TCP || uv_is_closing(handle)) return;
    sockaddr_storage local{}, remote{};
    int llen = sizeof(local), rlen = sizeof(remote);
    auto* tcp = reinterpret_cast<uv_tcp_t*>(handle);
    if (uv_tcp_getsockname(tcp, reinterpret_cast<sockaddr*>(&local), &llen) ||
        uv_tcp_getpeername(tcp, reinterpret_cast<sockaddr*>(&remote), &rlen)) return;
    if (local.ss_family != AF_INET || remote.ss_family != AF_INET) return;
    auto* a = reinterpret_cast<sockaddr_in*>(&local);
    auto* b = reinterpret_cast<sockaddr_in*>(&remote);
    char lip[64]{}, rip[64]{};
    uv_ip4_name(a, lip, sizeof(lip)); uv_ip4_name(b, rip, sizeof(rip));
    if (ntohs(a->sin_port) != tune->local_port || ntohs(b->sin_port) != tune->remote_port ||
        tune->local_ip != lip || tune->remote_ip != rip) return;
    uv_os_fd_t fd;
    if (uv_fileno(handle, &fd)) return;
    tune->found = true;
    auto socket = reinterpret_cast<SOCKET>(fd);
    tcp_keepalive values{};
    values.onoff = tune->idle_ms > 0; values.keepalivetime = tune->idle_ms;
    values.keepaliveinterval = tune->interval_ms;
    DWORD returned = 0;
    tune->interval = WSAIoctl(socket, SIO_KEEPALIVE_VALS, &values, sizeof(values),
                            nullptr, 0, &returned, nullptr, nullptr) == 0;
    // Supported on Windows 10 1703 and newer; older Windows retains system policy.
#ifdef TCP_KEEPCNT
    tune->probes = setsockopt(socket, IPPROTO_TCP, TCP_KEEPCNT,
                             reinterpret_cast<const char*>(&tune->count), sizeof(tune->count)) == 0;
#endif
}
static bool ReadString(napi_env env, napi_value value, std::string& text) {
    char buffer[64]{}; size_t size;
    if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &size) != napi_ok || size >= sizeof(buffer)) return false;
    text.assign(buffer, size); return true;
}
static napi_value Configure(napi_env env, napi_callback_info info) {
    napi_value args[7]; size_t argc = 7; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    Tune tune{};
    if (argc != 7 || !ReadString(env, args[0], tune.local_ip) || !ReadString(env, args[2], tune.remote_ip) ||
        napi_get_value_int32(env, args[1], &tune.local_port) != napi_ok ||
        napi_get_value_int32(env, args[3], &tune.remote_port) != napi_ok ||
        napi_get_value_int32(env, args[4], &tune.idle_ms) != napi_ok ||
        napi_get_value_int32(env, args[5], &tune.interval_ms) != napi_ok ||
        napi_get_value_int32(env, args[6], &tune.count) != napi_ok ||
        tune.local_port < 1 || tune.local_port > 65535 || tune.remote_port < 1 || tune.remote_port > 65535 ||
        tune.idle_ms < 0 || tune.interval_ms < 1 || tune.count < 1) {
        napi_throw_type_error(env, nullptr, "Invalid TCP Keepalive parameters"); return nullptr;
    }
    uv_loop_t* loop;
    if (napi_get_uv_event_loop(env, &loop) != napi_ok) { napi_throw_error(env, nullptr, "Node event loop unavailable"); return nullptr; }
    uv_walk(loop, Visit, &tune);
    napi_value result, flag; napi_create_object(env, &result);
    napi_get_boolean(env, tune.found, &flag); napi_set_named_property(env, result, "found", flag);
    napi_get_boolean(env, tune.interval, &flag); napi_set_named_property(env, result, "intervalApplied", flag);
    napi_get_boolean(env, tune.probes, &flag); napi_set_named_property(env, result, "countApplied", flag);
    return result;
}
static napi_value Init(napi_env env, napi_value exports) {
    if (!LoadSymbols()) return nullptr;
    napi_value function; napi_create_function(env, "configureKeepalive", NAPI_AUTO_LENGTH, Configure, nullptr, &function);
    napi_set_named_property(env, exports, "configureKeepalive", function); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
