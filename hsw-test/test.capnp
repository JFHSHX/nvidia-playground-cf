# hsw-test/test.capnp — raw workerd config running the composed hsw bundle
# (shim + patched hsw.js + dispatcher) directly as an ES module, bypassing
# miniflare entirely (no persist dirs, no Worker Loader). Diagnostic for the
# wasm-init trap: if the wasm init traps here too, the shim/bundle itself is
# broken for both the workerd and Node paths; if quiet, the Node vm sandbox
# is the culprit.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "hsw-test",
      worker = (
        modules = [
          ( name = "hsw-worker.js",
            esModule = embed "hsw-worker.js" )
        ],
        compatibilityDate = "2026-09-01"
      )
    )
  ],
  sockets = [
    ( name = "http",
      address = "*:8091",
      http = (),
      service = "hsw-test" )
  ]
);
