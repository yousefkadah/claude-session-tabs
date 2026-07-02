# JetBrains / PhpStorm Port — Feasibility & Implementation Reference

> **Purpose.** This is a scoped, source-backed plan for building a JetBrains/PhpStorm
> version of **Claude Code Tabs** (the VS Code extension in this repo). Park it here
> and pick it up once the VS Code extension is mature. It records what maps cleanly,
> what's blocked, the recommended architecture, and a ready-to-use scaffold.
>
> _Researched 2026-07-03 against JetBrains Marketplace, the IntelliJ Platform SDK docs,
> the `anthropics/claude-code` issue tracker, and a local scan of this machine._

---

## 1. Executive verdict

A JetBrains plugin is **buildable and worthwhile — but as a session *organizer*, not a
tab *manager***. The VS Code product's core premise ("one editor tab per Claude session,
reveal-on-click, live-tab tracking") **does not port**, because the official Claude Code
JetBrains plugin is a **terminal integration**, not a tabbed editor UI.

| Capability | JetBrains | Why |
|---|---|---|
| Read the same session data (`~/.claude/**/*.jsonl`) | ✅ **Yes** | Same `claude` CLI → same on-disk store. Client-agnostic. |
| Detect which sessions are "open" | ⚠️ **No reliable signal** | Sessions are terminal tabs; only a coarse per-IDE `~/.claude/ide/<port>.lock` exists, not per-session. |
| Open/reveal a session on click | ❌ **No API** | No action id / URL handler like `claude-vscode.editor.open`. Best: spawn `claude --resume <id>` in a *new* terminal; can't focus an existing one. |
| Grouping, colors, pin, flag, search, DnD, persistence, hover | ✅ **Yes** | First-class IntelliJ Platform tree/renderer/DnD/state APIs (some richer than VS Code). |

**Two UI idioms are fiddlier than in VS Code:** inline per-row action buttons (no
first-class API — use context menu + toolbar) and a numeric badge on the tool-window
stripe (no settable count — bake it into node text / stripe title).

---

## 2. The reality: the official Claude JetBrains plugin is terminal-based

- **Plugin:** *Claude Code [Beta]* — official **Anthropic PBC**, Marketplace id `27310`,
  plugin id **`com.anthropic.code.plugin`**, ~4.25M downloads. Supports IntelliJ IDEA,
  PhpStorm, PyCharm, WebStorm, GoLand, Android Studio. Does **not** bundle the CLI — it
  runs the separately-installed `claude`.
- **How sessions appear:** the plugin *"runs the `claude` command in your IDE's integrated
  terminal and connects to it."* Sessions are **terminal tabs inside the shared Terminal
  tool window** — not editor tabs, not even a dedicated tool window.
  (See `anthropics/claude-code#26755` "Dedicated Tool Window Instead of Terminal Tab".)
- **No open-session API:** no action id, no `vscode://…`-style URL handler, no "focus this
  terminal tab" command. The only lever is the CLI: `claude --resume <id>` / `--continue`,
  which opens a **new** terminal.
- **IDE↔CLI handshake:** the IDE plugin runs a WebSocket MCP server and writes
  `~/.claude/ide/<port>.lock` = `{pid, workspaceFolders, ideName, transport, authToken}`;
  the CLI reads it to connect. `ideName` would be `"PhpStorm"`/`"IntelliJ IDEA"`. (This
  lock is per-IDE, not per-session — and `#36284` reports the JetBrains beta sometimes
  fails to write it, so even this signal isn't fully reliable.)
- **Not to be confused with:** `JetBrains/phpstorm-claude-marketplace` (a set of Claude
  *skills* needing MCP, not a UI plugin), and the separate **ACP "Claude Agent"**
  integration inside JetBrains AI Assistant/Junie (`acp.registry.claude-acp`), which drives
  Claude over the Agent Client Protocol and does **not** use the `*.jsonl` terminal-session
  store the same way.

**Consequence:** a companion cannot piggy-back on the official plugin's UI. It must **own
its own tool window** listing sessions, and resume via a new terminal on click.

---

## 3. What to build instead — a session organizer

Same valuable data layer, honestly reframed product:

- A **Tool Window** listing this project's Claude conversations (parsed from
  `~/.claude/projects/<slug>/*.jsonl`).
- Your differentiators: **named + colored groups, pin, flag-for-attention, search, rich
  hover previews** (last messages, git branch, tokens, relative time).
- **Click →** open the transcript in a read-only editor **or** launch `claude --resume <id>`
  in a terminal tab.
- Drop the VS Code-only bits: live editor-tab tracking, the "new session in group" tab
  latching, and the horizontal webview strip (no per-session tabs to mirror).

---

## 4. Prior art

### Clauditor — the closest analog (open source, study it)
- Marketplace: <https://plugins.jetbrains.com/plugin/30981-clauditor> · Source (Kotlin):
  **<https://github.com/bdkent/clauditor>**
- A Tool Window listing Claude Code sessions: browse / search / **resume / fork / delete**,
  live status (thinking / idle / waiting-for-permission / unresponsive), message-history
  sidebar, a **Worktrees** tab, and a `.claude/` context browser. Sessions open as **custom
  `VirtualFile` editor tabs with embedded PTY terminals**. Targets IntelliJ 2024.3+, Kotlin
  coroutines, session restoration across restarts.
- **Data strategy differs from ours:** it embeds the CLI as a PTY and polls `~/.claude`
  status files, rather than parsing `*.jsonl` for display. **It does *not* do named+colored
  groups / pins / flags** — that organization layer is our gap to fill.
- **Reuse it for:** tool-window wiring, PTY/terminal integration, custom virtual-file tabs.
  **Don't copy:** its data model.

### Tab / session group managers (the "Tabstronaut" analogs)
- **Tab Group Manager** — named, colour-coded editor-tab groups. <https://plugins.jetbrains.com/plugin/30519-tab-group-manager>
- **Tab Session** (OSS Java, save/restore + settings page): <https://plugins.jetbrains.com/plugin/7209-tab-session> · <https://github.com/alp82/idea-tabsession>
- **SessionManager** <https://plugins.jetbrains.com/plugin/20227-sessionmanager>, **Tabs Per Project** <https://plugins.jetbrains.com/plugin/27536-tabs-per-project>.

Named+colored groups and save/restore are proven, accepted Marketplace patterns. **No plugin
combines Claude-session data + colored groups + pin + flag + search** — that's the niche.

### Other Claude-CLI JetBrains plugins (context)
Claude Code Chat (`31507`), Claude Code ToolBox (`30967`), Agent CLI (`31117`), CC GUIs
(`yhk1038/claude-code-gui-jetbrains`, `zhukunpenglinyutong/jetbrains-cc-gui`) — mostly
embedded-terminal wrappers, none are session organizers with groups.

---

## 5. Data layer (fully portable)

- **Same store:** `~/.claude/projects/<slug>/*.jsonl`. Slug = project path with every
  non-alphanumeric char → `-` (verified against real dirs in the VS Code build), with a
  fallback scan matching the `cwd` recorded inside a transcript.
- **`entrypoint` values on this machine:** `claude-vscode` (~131k records) and
  `claude-desktop` (~1.7k). **No** `claude-jetbrains`/`-intellij`/`-phpstorm` marker —
  JetBrains-originated sessions run plain `claude`, so they carry the **generic CLI
  entrypoint** (`cli`), and IDE detection is via the lock file, not `entrypoint`. Do **not**
  filter sessions by entrypoint for the JetBrains build.
- **Parsing:** one JSON object per line; derive title `customTitle > aiTitle > lastPrompt >
  summary > firstPrompt`; skip `"isSidechain":true`; accumulate tokens (`message.usage.*`),
  `gitBranch`, `cwd`; last user/assistant text from `message.content`. Full-read under a size
  cap, else head+tail sample. (This is a direct port of `src/data/transcript.ts`.)

---

## 6. IntelliJ Platform feature mapping

| VS Code feature | JetBrains mapping | Difficulty |
|---|---|---|
| Sidebar tree of sessions | Tool Window + `JBTree`/`Tree` (`com.intellij.ui.treeStructure.Tree`) | Easy |
| Named + colored groups | Group nodes + `ColoredTreeCellRenderer` + `SimpleTextAttributes(style, color)` | Easy |
| Per-session status icons | `renderer.icon = …` (`AllIcons.*` or custom SVG), `LayeredIcon` overlays, `ExecutionUtil.getLiveIndicator()` | Easy |
| Rich hover tooltip | HTML via `JTree.getToolTipText(MouseEvent)` (+ `ToolTipManager.sharedInstance().registerComponent(tree)`) | Easy — HTML fully supported |
| Colored text per node | `append(text, SimpleTextAttributes)` (multiple fragments/row) | Easy |
| Pin / flag | `AnAction` toggling persisted state + re-sort | Easy |
| Search / filter | `TreeSpeedSearch.installOn(tree)` (built-in) or a `SearchTextField` + model filter | Easy |
| Drag-and-drop between groups | `DnDSupport.createBuilder(tree)…install()`; `DnDAwareTree` + `DropMode.ON_OR_INSERT` for reordering | Medium |
| Context-menu actions | `PopupHandler.installPopupMenu(tree, ActionGroup, place)` | Easy |
| Toolbar actions | `ActionManager.createActionToolbar(...)` on a `SimpleToolWindowPanel` | Easy |
| **Inline row action buttons** | **No first-class API** → context menu / hover / custom renderer hit-testing | **Hard-ish** |
| **Flag count badge on stripe** | **No numeric badge API** → node text ("Flagged (3)") and/or `setStripeTitle("Claude (3)")` | **Partial** |
| Persist groups/pins/flags | `PersistentStateComponent` + `@State`/`@Storage` | Easy |
| Watch `~/.claude` for changes | Background poll via `Alarm`/coroutine (recommended for out-of-project paths); or `AsyncFileListener` + `LocalFileSystem.addRootToWatch` | Easy |
| Open a session ("command") | `AnAction` → open transcript, or terminal `claude --resume <id>`, or optional depend on the official plugin | Easy (logic is yours) |

**Threading:** parse `.jsonl` off the EDT; all tree-model mutations / `setIcon` /
`setStripeTitle` on the EDT (`invokeLater`). Wire `DnDSupport`, `PopupHandler`, watchers to
a `Disposable` (the tool-window content).

---

## 7. Persistence

Per-project service, `PersistentStateComponent`. Put shareable structure (group
names/colors/assignments) in a project file; put personal UI state (pins, flags, expansion)
in the workspace file (not shared in VCS).

```kotlin
@Service(Service.Level.PROJECT)
@State(name = "ClaudeCodeTabs", storages = [Storage("claudeCodeTabs.xml")])  // .idea/
class GroupStore : PersistentStateComponent<GroupState> {
    private var state = GroupState()
    override fun getState() = state
    override fun loadState(s: GroupState) { state = s }
    // createGroup / rename / recolor / delete / assign / togglePin / toggleFlag + MessageBus topic
    companion object { fun getInstance(p: Project): GroupStore = p.service() }
}

data class GroupState(
    var groups: MutableList<GroupDef> = mutableListOf(),
    var assignments: MutableMap<String, String> = mutableMapOf(),  // sessionId -> groupId
    var pinned: MutableList<String> = mutableListOf(),
    var flagged: MutableList<String> = mutableListOf(),
    var version: Int = 1,
)
```
`@Service`-annotated classes auto-register (no `plugin.xml` entry needed). Use
`StoragePathMacros.WORKSPACE_FILE` for pins/flags if they shouldn't be VCS-shared.

---

## 8. JSON parsing & file watching

- **JSON:** bundle your own (don't rely on the platform's Gson). Add the
  `org.jetbrains.kotlin.plugin.serialization` Gradle plugin + `kotlinx-serialization-json`;
  `@Serializable` DTOs; `Json { ignoreUnknownKeys = true }`; decode per line.
- **Watch:** a background **poll** (`com.intellij.util.Alarm` or a coroutine on
  `Dispatchers.IO`) that lists `.jsonl`, compares `lastModified`/size, reloads changed
  sessions, updates the tree on the EDT. Most reliable for files the IDE doesn't index.
  (VFS `AsyncFileListener` works too but needs `LocalFileSystem.addRootToWatch` for
  out-of-project paths.)

---

## 9. Build & publish

- **Build system:** IntelliJ Platform Gradle Plugin **2.x** (`org.jetbrains.intellij.platform`),
  Kotlin, JDK 21. Start from the official template:
  **<https://github.com/JetBrains/intellij-platform-plugin-template>** ("Use this template").
- **Cross-IDE:** depend only on `com.intellij.modules.platform` → runs in PhpStorm and all
  IntelliJ-based IDEs; no product-specific module needed.
- **Publish:** **free**. First upload is **manual** at plugins.jetbrains.com → Upload plugin.
  Later releases via the `publishPlugin` Gradle task + a `PUBLISH_TOKEN`. **Signing is
  required** (`signPlugin`). Every plugin/update gets a **human review (~3–4 working days)**.
  Because it reads `~/.claude`, describe data handling in the listing.
- **Key tasks:** `runIde` (sandbox), `buildPlugin` (zip), `verifyPlugin`, `signPlugin`,
  `publishPlugin`.

---

## 10. Scaffold

### `settings.gradle.kts`
```kotlin
rootProject.name = "claude-code-tabs"
pluginManagement {
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.1.20"
        id("org.jetbrains.changelog") version "2.5.0"
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
    id("org.jetbrains.intellij.platform.settings") version "2.16.0" // bump to latest 2.x
}
dependencyResolutionManagement {
    repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
}
```

### `build.gradle.kts`
```kotlin
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.20"
    id("org.jetbrains.changelog")
}
group = "co.forbit.claudetabs"
version = "0.1.0"
kotlin { jvmToolchain(21) }

dependencies {
    intellijPlatform {
        create("PS", "2025.2")            // PhpStorm; or intellijIdeaCommunity("2025.2")
        testFramework(TestFrameworkType.Platform)
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.0")
    testImplementation("junit:junit:4.13.2")
}
intellijPlatform {
    pluginConfiguration {
        id = "co.forbit.claude-code-tabs"
        name = "Claude Code Tabs"
        ideaVersion { sinceBuild = "243" } // 2024.3+
    }
    publishing { token = providers.environmentVariable("PUBLISH_TOKEN") }
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
}
```

### `src/main/resources/META-INF/plugin.xml`
```xml
<idea-plugin>
    <id>co.forbit.claude-code-tabs</id>
    <name>Claude Code Tabs</name>
    <vendor email="abed@forbit.co.il" url="https://github.com/yousefkadah">yousefkadah</vendor>
    <depends>com.intellij.modules.platform</depends>
    <resource-bundle>messages.ClaudeTabsBundle</resource-bundle>

    <extensions defaultExtensionNs="com.intellij">
        <toolWindow id="Claude Code Tabs" anchor="left" secondary="false"
                    icon="/icons/claudeToolWindow.svg" canCloseContents="false"
                    factoryClass="co.forbit.claudetabs.toolwindow.ClaudeTabsToolWindowFactory"/>
        <projectService serviceImplementation="co.forbit.claudetabs.data.SessionStore"/>
        <projectService serviceImplementation="co.forbit.claudetabs.state.GroupStore"/>
    </extensions>

    <actions>
        <action id="ClaudeTabs.NewGroup" class="co.forbit.claudetabs.action.NewGroupAction"
                text="New Group" icon="AllIcons.General.Add"/>
        <action id="ClaudeTabs.Refresh" class="co.forbit.claudetabs.action.RefreshAction"
                text="Refresh" icon="AllIcons.Actions.Refresh"/>
        <!-- OpenSession, TogglePin, ToggleFlag, AssignToGroup, Rename/Recolor/DeleteGroup -->
    </actions>
</idea-plugin>
```

### `ClaudeTabsToolWindowFactory.kt`
```kotlin
package co.forbit.claudetabs.toolwindow

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class ClaudeTabsToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = ClaudeTabsPanel(project, toolWindow)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
    override fun shouldBeAvailable(project: Project) = true
}
```

### `ClaudeTabsPanel.kt` (toolbar + search + tree)
```kotlin
package co.forbit.claudetabs.toolwindow

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.ui.PopupHandler
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.components.BorderLayoutPanel
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

class ClaudeTabsPanel(private val project: Project, toolWindow: ToolWindow) : BorderLayoutPanel() {
    private val treeModel = DefaultTreeModel(DefaultMutableTreeNode("root"))
    private val tree = Tree(treeModel).apply {
        isRootVisible = false
        cellRenderer = SessionTreeCellRenderer()   // colored groups, status dots, pin/flag
    }
    private val search = SearchTextField()

    init {
        val group = DefaultActionGroup().apply {
            add(ActionManager.getInstance().getAction("ClaudeTabs.NewGroup"))
            add(ActionManager.getInstance().getAction("ClaudeTabs.Refresh"))
        }
        val toolbar = ActionManager.getInstance().createActionToolbar("ClaudeCodeTabs", group, true)
        toolbar.targetComponent = tree
        addToTop(search)
        addToCenter(JBScrollPane(tree))
        // PopupHandler.installPopupMenu(tree, contextGroup, "ClaudeTabsPopup")
        // DnDSupport.createBuilder(tree)…install(); double-click -> OpenSessionAction
    }
}
```

Building blocks: `Tree`/`JBTree` + `DefaultTreeModel`, `ColoredTreeCellRenderer`, `JBColor`,
`TreeSpeedSearch`, `ActionToolbar`/`AnAction`, `PopupHandler`, `DnDSupport`;
`LocalFileSystem.refreshAndFindFileByNioFile(...)` + `FileEditorManager.openFile(...)` to open
a transcript outside project roots.

---

## 11. Proposed class layout (mirrors this repo's layers)

Package root `co.forbit.claudetabs`.

| Layer | VS Code file | Kotlin class(es) |
|---|---|---|
| Data: parse | `src/data/transcript.ts` | `data/TranscriptParser.kt` (`parseSession`, `readCwd`, `extractText`) |
| Data: store | `src/data/sessionStore.ts` | `data/SessionStore.kt` `@Service(PROJECT)` (resolve slug from `project.basePath`, `list()`, mtime/size cache, `invalidate`) |
| Model | `src/model/types.ts` | `model/Types.kt` (`SessionMeta`, `SessionEntry`, `GroupDef`, `SessionStatus`; drop `LiveTab`/`Strip*`) |
| State | `src/data/groupStore.ts` | `state/GroupStore.kt` `@Service(PROJECT)` + `PersistentStateComponent` |
| View: model | `SessionTreeProvider.build()`/`computeGroups()`/`visibleEntries()` | `view/SessionModelBuilder.kt` (port `rank`/`sortEntries`/`visibleEntries`) |
| View: nodes | `GroupTreeNode`/`SessionTreeNode` | `view/nodes/GroupNode.kt`, `view/nodes/SessionNode.kt` |
| View: renderer | `groupItem()`/`sessionItem()`/`sessionIcon()` | `view/SessionTreeCellRenderer.kt` (`ColoredTreeCellRenderer`) |
| View: tool window | `views` contribution | `toolwindow/ClaudeTabsToolWindowFactory.kt`, `toolwindow/ClaudeTabsPanel.kt` |
| View: search | extension search | `view/SessionFilter.kt` |
| View: DnD | `handleDrag`/`handleDrop` | `view/SessionTreeDnD.kt` (`DnDSupport`) |
| Actions | `src/commands.ts` | `action/` — `NewGroup`, `RenameGroup`, `RecolorGroup`, `DeleteGroup`, `AssignToGroup`, `TogglePin`, `ToggleFlag`, `OpenSession`, `Refresh` (each `AnAction`) |
| Watching | `FileSystemWatcher` | `data/SessionWatcher.kt` (poll or `AsyncFileListener`) |
| Activation | `activate()` | `startup/ClaudeTabsStartupActivity.kt` (`ProjectActivity`) |
| Icons/i18n | `resources/*.svg`, nls | `ClaudeTabsIcons.kt` (`IconLoader`), `messages/ClaudeTabsBundle.properties` |
| Format utils | `src/util/format.ts` | `util/Format.kt` (`truncate`, `formatTokens`, `formatRelative`) |

### Suggested build order
1. `TranscriptParser` + `SessionStore` + `model` (pure, unit-testable, no UI — direct TS port).
2. `GroupStore` persistence.
3. Tool window + tree + renderer (read-only list).
4. Actions: groups, pin, flag, assign, search.
5. DnD + file watching.
6. Optional: open/resume via terminal or embedded PTY.

**Notable differences to plan for:** no exposed "open Claude tab" API (organize transcripts,
resume via terminal); `workspaceState` → `PersistentStateComponent`; `ThemeColor("charts.*")`
→ `JBColor`; `EventEmitter`/`onDidChange` → `MessageBus` `Topic`; `fs/promises` → coroutines /
`AppExecutorUtil` (never block the EDT).

---

## 12. Local machine notes (as of 2026-07-03)
- **No PhpStorm/IntelliJ `.app`** in `/Applications` (only Android Studio). But **PhpStorm
  2026.1 config exists** (`~/Library/Application Support/JetBrains/PhpStorm2026.1/`) — it was
  installed at some point. The official Claude plugin is **not** installed.
- So there's nothing to test against locally until PhpStorm + `Claude Code [Beta]` are
  (re)installed and the `claude` CLI is used from within it.

---

## 13. Key sources
- Claude Code JetBrains docs — <https://code.claude.com/docs/en/jetbrains>
- Claude Code [Beta] (official) — <https://plugins.jetbrains.com/plugin/27310-claude-code-beta->
- `anthropics/claude-code#26755` (tool window vs terminal), `#36284` (lock file)
- Clauditor — <https://plugins.jetbrains.com/plugin/30981-clauditor> · <https://github.com/bdkent/clauditor>
- IntelliJ Platform Plugin Template — <https://github.com/JetBrains/intellij-platform-plugin-template>
- IntelliJ Platform Gradle Plugin 2.x — <https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html>
- Tool Windows — <https://plugins.jetbrains.com/docs/intellij/tool-windows.html>
- Lists & Trees — <https://plugins.jetbrains.com/docs/intellij/lists-and-trees.html>
- Persisting State — <https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html>
- Action System — <https://plugins.jetbrains.com/docs/intellij/action-system.html>
- `DnDSupport` — <https://github.com/JetBrains/intellij-community/blob/master/platform/platform-api/src/com/intellij/ide/dnd/DnDSupport.java>
- Publishing a Plugin — <https://plugins.jetbrains.com/docs/intellij/publishing-plugin.html>
- Tab Group Manager — <https://plugins.jetbrains.com/plugin/30519-tab-group-manager> · Tab Session (OSS) — <https://github.com/alp82/idea-tabsession>
