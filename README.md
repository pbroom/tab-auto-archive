# Tab Auto-Archive for Zen

Arc-style auto-archiving for Zen Browser. Unpinned tabs you haven't viewed in a while close on their own and go into an archive you can search. Restoring a tab puts it back in its original space with its back/forward history.

Built against Zen 1.24b (Firefox 159) source.

## What it does

- **Auto-archive.** Every 5 minutes it closes unpinned tabs that haven't been viewed for longer than the threshold (12 hours by default, the same as Arc). It covers every space in the window, not just the one you're looking at.
- **Never touched:** pinned tabs, Essentials, the selected tab, tabs playing audio, picture-in-picture, tabs on a call or screen share, split-view tabs, Glance previews, tabs still loading, tabs in folders or groups (configurable), and domains you exclude. Private windows are skipped entirely.
- **Closing a tab archives it**, as it does in Arc. You can turn this off.
- **Archive panel.** An archive-box button in the sidebar footer, next to the spaces buttons, opens the panel:
  - It lists the current space's archive grouped into Today, Yesterday, This week and Older, with a toggle to show all spaces.
  - Search matches titles and URLs; press Enter to open the top result.
  - Click a row to restore the tab and switch to its space. Middle-click or Ctrl/Cmd-click restores it in the background.
  - The × button or Delete removes an entry.
  - The footer has a menu for "Archive after: 1h / 6h / 12h / 24h / 7d / 30d / Never", an **Archive idle now** button, and **Clear**.
- **Tab context menu.** There is an **Archive Tab** item, which works on several selected tabs at once.
- **Storage.** The archive is saved to `zen-tab-auto-archive.json` in your profile and shared live across windows. Each archived tab keeps its last 10 history entries. Form data and page storage are not kept. Old entries expire after 30 days by default, with at most 1000 entries. The same page in the same space keeps only its newest entry.

## Install

### Option A: fx-autoconfig (if you don't use Sine)

1. Set up [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) for Zen: copy its `program/` files into the Zen install folder (on macOS, `/Applications/Zen.app/Contents/Resources/`) and its `profile/chrome/` files into your profile's `chrome/` folder. You can find the profile folder under `about:profiles`.
2. Copy `tab-auto-archive.uc.js` into `<profile>/chrome/JS/`.
3. Restart Zen with the startup cache cleared: open `about:support`, then **Clear startup cache…**.
4. The archive-box button shows up in the sidebar footer. If it doesn't, right-click the sidebar, choose **Customize Toolbar**, and drag **Archived Tabs** into place.

The script includes its own CSS, so there is nothing else to copy.

### Option B: Sine


1. In `about:config`, set `sine.allow-unsafe-js` to `true`. Sine runs JS only from store mods unless this is on.
2. Go to Settings → Sine → install from a GitHub URL, and paste `https://github.com/pbroom/tab-auto-archive`.
3. The settings in `preferences.json` show up in Sine's mod settings. The mod supports unloading, so toggling it off removes the button and stops archiving without a restart.

## Settings (`about:config`)

| Pref | Default | |
|---|---|---|
| `zen.tab-auto-archive.enabled` | `true` | Auto-archive on or off. Manual archive and archive-on-close still work when it's off. |
| `zen.tab-auto-archive.idle-minutes` | `720` | Minutes since a tab was last viewed. |
| `zen.tab-auto-archive.archive-on-close` | `true` | Archive tabs you close yourself. |
| `zen.tab-auto-archive.check-interval-minutes` | `5` | How often it sweeps. |
| `zen.tab-auto-archive.retention-days` | `30` | `0` keeps entries forever. |
| `zen.tab-auto-archive.max-entries` | `1000` | |
| `zen.tab-auto-archive.skip-grouped-tabs` | `true` | Leave tabs in folders or groups alone. |
| `zen.tab-auto-archive.excluded-domains` | `""` | Comma-separated; subdomains match. |

## How it works

`tab-auto-archive.uc.js` runs in each browser window. It reads the information Zen keeps on each tab (`zen-workspace-id`, `zen-essential`, `pinned`, `lastAccessed`) and gets tabs from every space through `gZenWorkspaces.allStoredTabs`. A WebExtension can't do this, because Zen only shows extensions the active space's tabs.

When it archives a tab, it saves `SessionStore.getTabState()`. To restore, it switches to the tab's space, opens a blank tab, moves it into that space's strip with `gZenWorkspaces.moveTabToWorkspace`, and applies the saved state with `SessionStore.setTabState`. If the original space has been deleted, the tab opens in the current space.

## Known gaps

- It hasn't been run in a real Zen build yet. The tests run the script against mocked Zen and Firefox APIs written from the 1.24b source (`tests/`, run with `npm install && npm test`). Check it in your own Zen before relying on it.
- If you reopen a tab with Ctrl/Cmd+Shift+T after closing it, its archive entry stays (it isn't removed).
- If a page asks "Leave page?" (unsaved form data), you'll get that prompt when its tab is archived. This is deliberate, so nothing is lost silently.
- Zen internals change often. If an update renames `gZenWorkspaces` or the tab attributes, the mod falls back to plain Firefox tabs and may stop seeing other spaces.

## License

MIT
