---
paths:
  - "src/lib/api.ts"
  - "src/lib/types.ts"
  - "src/lib/processing.ts"
  - "src/dev/mockBackend.ts"
  - "src-tauri/src/commands.rs"
  - "src-tauri/src/model.rs"
  - "src-tauri/src/lib.rs"
  - "src-tauri/src/dsp.rs"
  - "src-tauri/capabilities/**"
---

# The frontend–backend contract

Nothing checks at compile time that `api.ts` and `commands.rs` agree. The safety net is
`ipc_tests` in `lib.rs`, which sends the same JSON the UI sends. Keep that net complete.

## Adding a command (every step, same commit)

1. **Rust:** `#[tauri::command] pub async fn snake_name(state: State<'_, AppState>, …) -> CmdResult<T>`
   in `commands.rs`. Map errors with `.map_err(err)`. Put file-system, decode or other CPU-heavy
   work inside `tauri::async_runtime::spawn_blocking`. Add a `///` doc comment saying what it
   does from the user's side.
2. **Register** it in `with_commands()` in `lib.rs`.
3. **Types:** new structs go in `model.rs` (or next to the command if only it uses them) with
   `#[serde(rename_all = "camelCase")]`. Mirror them in `src/lib/types.ts`, with the same field
   order and the same doc comments. Optional fields Rust sends back are `Option<T>` ↔ `T | null` (serde
   writes `null`, not a missing key). Optional *arguments* the UI may leave out are `?:` in TS
   and `Option<T>` or `#[serde(default)]` in Rust.
4. **Binding:** one line in the `api` object in `src/lib/api.ts`, named the camelCase version of
   the command. Pass arguments as an object with camelCase keys. Give it a `/** */` comment when
   the arguments aren't obvious (units, null meaning, path formats).
5. **Test:** call it in `ipc_tests::frontend_calls_round_trip` (or a new `#[test]` in the same
   module) with the exact JSON shape, and assert on the result.
6. **Mock:** add a `case "snake_name":` to `src/dev/mockBackend.ts` if it returns data the UI
   reads. Commands that return nothing can fall through to `default: return null`.
7. **Plugins:** if the frontend now uses a new plugin API, add its permission to
   `capabilities/default.json`, and give the mock a `plugin:x|y` case.

Renaming or removing a command means the same steps in reverse. Search for the snake_case and
camelCase names in `src/`, `lib.rs` and the mock.

## Changing a shared type
- Add fields; don't rename or remove them unless you update every reader. Rows come from SQL in
  `db.rs` (`ROW_COLS` / row mapping), so a new `SampleRow` field means touching `ROW_COLS`, the
  mapper, `types.ts`, the mock's row generator and any test that compares rows.
- Enum-like strings (`"name" | "metadata" | "audio" | "user"`, `Kind`, `Aspect`, `SortKey`) are
  matched by value on both sides. Add a variant to both, plus the mock.
- `ProcessParams` changes must keep preview, render, export and variation identical. Change
  `processing.ts`, `dsp.rs`, the tests and the mock together. See wiring.md §4.

## Errors
- Commands return `Result<T, String>`, and the string is shown to the user. Write it as a
  sentence a producer understands ("Couldn't read the folder …"), not a debug dump.
- Don't `unwrap()`/`expect()` on user data or the file system inside a command. A panic there
  takes down the IPC call with no useful message.
- On the frontend, every `api.*` call either awaits inside `try { … } catch (e) { toast(errorMessage(e)) }`
  or chains `.catch((e) => toast(errorMessage(e)))`. The only exceptions are fire-and-forget
  calls whose failure is harmless (`.catch(() => {})`). Add a comment saying why.

## Events
New backend → frontend events need: an emit in Rust with a `Serialize` payload in camelCase, an
`events.onX` wrapper in `api.ts` with a mirrored type, a subscription and unsubscription in
`App.tsx`, and a row in wiring.md §2.
