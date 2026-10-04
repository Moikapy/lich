# Ossuary Dockview popout spike (#93)

## Result: **pass** (code path green)

Dockview native popout groups work in Electron when the renderer is served
over `http://127.0.0.1` (not `file:`).

## What landed

| Piece | Behavior |
| --- | --- |
| Origin | Dev: Vite on `127.0.0.1:5173`. Prod: ephemeral loopback static server for `dist/renderer`. |
| `popout.html` | Blank same-origin page (Vite multi-page entry + static serve). |
| `setWindowOpenHandler` | Allows only same-origin `http://127.0.0.1:<port>/popout.html`; child windows get the same preload / isolation prefs. |
| Tear-out | Tab context menu → **Open in New Window** (`popout`). Works for any registered pane generically. |
| Re-dock | Close the OS window → Dockview returns the group to the main grid. |
| Layout (#92) | `api.toJSON()` includes `popoutGroups`; restore awaits `popoutRestorationPromise` so popouts re-open after relaunch. |

## How to try

1. `cd apps/ossuary && bun run dev`
2. Right-click a pane tab (e.g. Scratch) → **Open in New Window**
3. Close the popout window → pane re-docks
4. Quit / relaunch with a popout open → layout restore should re-open it

## Limitations (spike scope)

- Popout requires popup windows; Electron must not block `window.open` for the allowlisted URL.
- Only `/popout.html` on the renderer origin is permitted — other `window.open` targets are denied.
- Uncloseable main Chat can still be popped out (Dockview treats popout separately from tab close).
- Sibling panes from #90/#91 are not rewritten; once registered they get the same context menu.
- Manual multi-monitor dogfood is still recommended before treating popout as product-ready.

## Fallback (if popout regresses)

In-window **Float** remains on the same tab context menu. That keeps a detachable
panel inside the main BrowserWindow without a second OS window — the plan's
documented fallback if native popout fails in an environment.
