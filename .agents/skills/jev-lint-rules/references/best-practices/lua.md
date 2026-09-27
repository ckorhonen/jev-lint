# Lua candidates

Lua has few guard rails. These candidates target the classic semantic traps: accidental
globals, ignored `pcall` results, 1-based arrays and holes, pattern metacharacters, and
running strings as code. Luacheck and selene catch undefined globals and unused variables,
but they cannot tell whether a value is intended or safe. Decide first which runtime the
repo targets: plain Lua, LuaJIT, Neovim, Roblox/Luau, LÖVE or OpenResty. Several
exceptions depend on it. Validate each candidate on labeled cases before enabling it.

```json
{
  "id": "lua-implicit-global",
  "question": "Does `added_code` assign a new variable or define a function without `local` (e.g. `count = 0` or `function helper() ... end`) inside a module, function, or script where it is meant to be local, creating an accidental global?",
  "true": "A variable or function is created as a global because `local` is missing.",
  "false": "New variables and functions are declared with `local`, are fields of a table (`M.helper = ...`, `function M.helper()`), assign to an upvalue or variable declared earlier in the snippet, or are intentional globals the runtime expects (e.g. LÖVE callbacks `love.update`, a Neovim `_G` export, or a config global a comment says is intended).",
  "fix": "Declare it with `local` (or attach it to the module table).",
  "when": ["="]
}
```
Skip if: luacheck (warnings 111/112/113) or selene `global_usage` runs in CI with a defined globals list.

```json
{
  "id": "lua-pcall-result-ignored",
  "question": "Does `added_code` call `pcall(...)` or `xpcall(...)` and ignore its first return value (the success flag) — calling it as a bare statement, or using only the second value — so an error is silently swallowed?",
  "true": "The protected call's success flag is never checked.",
  "false": "The code checks the status (`local ok, err = pcall(f); if not ok then ... end`), passes it on, or asserts it; or a comment says ignoring the failure is intended (best-effort cleanup); or there is no pcall/xpcall.",
  "fix": "Capture `local ok, err = pcall(...)` and handle or log the failure.",
  "when": ["pcall"]
}
```
Skip if: none. luacheck does not check this.

```json
{
  "id": "lua-length-with-holes",
  "question": "Does `added_code` use the length operator `#t` or `ipairs(t)` on an array-like table that the same code creates holes in — setting `t[i] = nil` for an index in the middle, or filling it with values that can be nil (`{a, b, c}` where b may be nil)?",
  "true": "`#` or `ipairs` is applied to a table with nil holes, which gives an undefined length or stops early.",
  "false": "Elements are removed with `table.remove`, the length is tracked in a separate counter or `n` field (`table.pack`), holes are only at the end, or the table is iterated with `pairs`; or no `#`/`ipairs` is used on such a table.",
  "fix": "Use table.remove, track the count separately (`t.n`), or iterate with pairs.",
  "when": ["#|ipairs"]
}
```
Skip if: none.

```json
{
  "id": "lua-concat-in-loop",
  "question": "Does `added_code` build a string by repeated concatenation inside a loop (`s = s .. piece` within `for` or `while`) instead of collecting the pieces in a table and calling `table.concat` once?",
  "true": "A loop grows a string with `..` on every iteration, which is quadratic.",
  "false": "Pieces are inserted into a table and joined with `table.concat`, or the loop runs only a small fixed number of times, or `..` is not used to accumulate a string inside a loop.",
  "fix": "Collect pieces in a table and join them with table.concat after the loop.",
  "when": ["\\.\\."]
}
```
Skip if: the code is not performance-sensitive and loops are known to be tiny.

```json
{
  "id": "lua-mutate-during-iteration",
  "question": "Does `added_code` call `table.remove(t, i)` inside a forward numeric loop over the same table (`for i = 1, #t do`), or add new keys to a table while iterating it with `pairs`/`next`?",
  "true": "The table changes during iteration, so elements are skipped or iteration is undefined.",
  "false": "The loop runs backwards (`for i = #t, 1, -1`), builds a new table, or only assigns to existing keys or sets them to nil during `pairs` (which is allowed); or the table is not modified during the loop.",
  "fix": "Iterate backwards when removing, or build a new filtered table.",
  "when": ["table\\.remove|pairs"]
}
```
Skip if: none.

```json
{
  "id": "lua-exec-external-string",
  "question": "Does `added_code` pass a string built from a variable or from outside data (user input, a request, a file, a network message) to `load`, `loadstring`, `dofile`, `loadfile`, `os.execute`, or `io.popen`, without restricting it (an allow-list, a sandboxed environment table, or shell-escaping)?",
  "true": "Externally influenced text is run as Lua code or as a shell command.",
  "false": "Only constant strings or internal module paths are loaded or executed, `load` is given a restricted `env` table for data that is expected to be code (a sandboxed config), or shell arguments are escaped or checked against an allow-list; or none of these functions are called.",
  "fix": "Do not execute external strings; parse data with a real parser and escape or allow-list shell arguments.",
  "when": ["load|dofile|os\\.execute|io\\.popen"]
}
```
Skip if: none.

```json
{
  "id": "lua-zero-based-index",
  "question": "Does `added_code` treat a Lua array as 0-based — reading or writing `t[0]` as its first element, or looping `for i = 0, #t - 1` — in plain Lua table code?",
  "true": "Array code assumes indices start at 0, so the first element is missed or `#`/`ipairs` ignore index 0.",
  "false": "Arrays use 1-based indexing (`t[1]`, `for i = 1, #t`); or 0 is used on purpose as a map key; or the data is a 0-based FFI/cdata array, buffer offset, or byte position from an API that is 0-based; or there is no array indexing.",
  "fix": "Index arrays from 1 (`for i = 1, #t`).",
  "when": ["\\[0\\]|=\\s*0\\s*,"]
}
```
Skip if: the code is mostly LuaJIT FFI or buffer handling, where 0-based offsets are normal.

```json
{
  "id": "lua-unescaped-pattern",
  "question": "Does `added_code` pass a variable (not a literal pattern) as the pattern argument to `string.find`, `string.match`, `string.gmatch`, `string.gsub`, or their method forms (`s:find(x)`), when that variable holds plain text that may contain magic characters (`. - + * ? [ ] ^ $ % ( )`), without escaping it or passing `plain = true` to find?",
  "true": "Plain text is used as a Lua pattern, so characters like `.` or `-` change the match.",
  "false": "The text is escaped first (`x:gsub('%p', '%%%0')`), `string.find(s, x, 1, true)` uses plain mode, or the variable is a deliberate pattern; or all patterns are literals.",
  "fix": "Escape magic characters or use `string.find(s, text, 1, true)` for a plain search.",
  "when": ["find|match|gsub|gmatch"]
}
```
Skip if: none.
