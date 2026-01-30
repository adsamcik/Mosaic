# SPEC: Block Editor UX Design for Mosaic Albums

> **Feature:** User Experience and Editor Design for Block-Based Content
> **Status:** Design Phase
> **Date:** 2026-01-29
> **Companion to:** [SPEC-BlockBasedContentSystem.md](./SPEC-BlockBasedContentSystem.md)

---

## Executive Summary

This specification defines the **user experience and editor design** for Mosaic's block-based album content system. It covers interaction patterns, editor modes, toolbar design, mobile considerations, and component recommendations.

**Key Principles:**
1. **Content-first, controls-hidden** — Editing UI appears contextually, not always visible
2. **Zero learning curve** — Familiar patterns from Notion, Medium, Apple Notes
3. **Touch-native** — Mobile isn't an afterthought; touch is primary
4. **Progressive disclosure** — Simple actions easy, advanced features discoverable

---

## Table of Contents

1. [Editor Modes and Workflows](#1-editor-modes-and-workflows)
2. [Block Manipulation UX](#2-block-manipulation-ux)
3. [Photo-Specific UX](#3-photo-specific-ux)
4. [Rich Text Editing](#4-rich-text-editing)
5. [Mobile Considerations](#5-mobile-considerations)
6. [Onboarding and Empty States](#6-onboarding-and-empty-states)
7. [Component Recommendations](#7-component-recommendations)
8. [Wireframe Descriptions](#8-wireframe-descriptions)
9. [Keyboard Shortcuts](#9-keyboard-shortcuts)
10. [Accessibility](#10-accessibility)

---

## 1. Editor Modes and Workflows

### 1.1 Mode Philosophy: "Always Editable"

**Recommendation: No explicit View/Edit mode toggle.**

Unlike traditional CMS systems, Mosaic should adopt the **Apple Notes / Notion model**:
- Content is always editable when you're the owner/editor
- Click anywhere to start typing
- Formatting controls appear contextually

**Rationale:**
- Photo albums are personal; you're usually editing your own content
- Reduces cognitive overhead ("am I in edit mode?")
- Matches modern content app expectations

### 1.2 Implicit Mode States

While there's no explicit toggle, the UI has implicit states:

| State | Trigger | UI Behavior |
|-------|---------|-------------|
| **Viewing** | Scrolling, no focus | Clean view, minimal chrome |
| **Focused** | Click any block | Block outline, drag handle appears |
| **Editing** | Double-click or type | Caret visible, inline toolbar available |
| **Selecting** | Shift+click or drag-select | Multi-block selection state |

### 1.3 Entering Edit State

```
┌─────────────────────────────────────────────────────────────┐
│  🏠 Album Name                                    [⚙️] [📤] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  # Trip to Iceland                                ← Click   │
│  ─────────────────────────────                   anywhere   │
│                                                  to edit    │
│  We landed at Keflavik airport...     ← Caret blinks here   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ [📷][📷][📷]  Photo Group (3 photos)                 │   │
│  │ Click to select, double-click to configure           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 Exiting Edit State

| Action | Result |
|--------|--------|
| Click outside block | Focus lost, auto-save triggers |
| Press `Escape` | Deselect, return to viewing |
| Scroll away | Focus preserved (can scroll back) |
| Navigate away | Auto-save, navigate |

### 1.5 Read-Only Mode (Viewers/Share Links)

For users without edit permissions:
- No cursor changes on hover
- No drag handles
- No add block buttons
- Optional "Enable Editing" if they have editor role but are viewing

---

## 2. Block Manipulation UX

### 2.1 Adding New Blocks

**Three complementary methods:**

#### Method 1: Slash Command (Primary - Desktop)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  /                      ← Type slash at start of line      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  📝 Text          Paragraph text                       │ │
│  │  📢 Heading       Section header (H1, H2, H3)          │ │
│  │  🖼️ Photo         Insert single photo                  │ │
│  │  📷 Photo Group   Grid of multiple photos              │ │
│  │  📍 Map           Show locations on map                │ │
│  │  📅 Date          Timeline marker                      │ │
│  │  ── Divider       Visual separator                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘

- Type to filter: /photo shows "Photo" and "Photo Group"
- Arrow keys + Enter to select
- Escape to dismiss
```

#### Method 2: Plus Button (Primary - Mobile, Secondary - Desktop)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Some paragraph text here...                                │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│ (+)  Hover/focus reveals the plus button on left margin    ││
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  More content below...                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Clicking (+) opens the same menu as slash command
```

**Plus Button Position:**
- Desktop: Left gutter, appears on hover
- Mobile: Floating action button (FAB) at bottom-right, always visible

#### Method 3: Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` (at end) | New text block below |
| `Ctrl/Cmd + Enter` | New block after current (preserves type) |
| `Ctrl/Cmd + Shift + 1/2/3` | Insert H1/H2/H3 |
| `Ctrl/Cmd + Shift + P` | Insert photo picker |

### 2.2 Block Selection

#### Single Selection

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ⋮ │ Selected block gets:                                  │
│    │ - Light background highlight (#f0f4ff)                │
│    │ - Drag handle (⋮⋮) on left                            │
│    │ - Action menu (...) on right                          │
│                                                         ... │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Multi-Selection

- **Shift + Click**: Range select from current to clicked
- **Ctrl/Cmd + Click**: Toggle individual block selection
- **Drag-select**: Not recommended (conflicts with text selection)

```
┌─────────────────────────────────────────────────────────────┐
│  Selected blocks (3)                       [🗑️ Delete] [⋮] │
├─────────────────────────────────────────────────────────────┤
│  ✓│ Block 1 - highlighted                                  │
│  ✓│ Block 2 - highlighted                                  │
│  ✓│ Block 3 - highlighted                                  │
│   │ Block 4 - not selected                                  │
└─────────────────────────────────────────────────────────────┘

Floating action bar appears for bulk operations
```

### 2.3 Block Reordering

#### Desktop: Drag Handle

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ⋮⋮ │ Grab the drag handle to reorder       ← cursor: grab │
│     │                                                       │
│ ────│─────────────────────────────────────── ← drop zone   │
│     │                                                       │
│  ⋮⋮ │ Another block                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

- Drag handle (⋮⋮) appears on hover/focus
- Drop zone indicator shows where block will land
- Smooth animation on drop
```

#### Mobile: Long-Press + Drag

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 📝 Block content                           [≡]        │  │
│  │                                         drag handle   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Long-press (300ms) → Haptic feedback → Lift + drag        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Alternative: Explicit "Reorder" mode toggle
```

#### Keyboard Reordering

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Shift + ↑` | Move block up |
| `Ctrl/Cmd + Shift + ↓` | Move block down |

### 2.4 Block Deletion

**Two patterns:**

#### Pattern A: With Undo (Recommended)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Block deleted                                   [Undo]     │
│                                                             │
│  ← Toast notification with undo button (5 seconds)         │
│                                                             │
└─────────────────────────────────────────────────────────────┘

- Delete via block menu, keyboard (Delete/Backspace), or action bar
- Toast with auto-dismiss after 5s
- Block immediately removed from view
- Actual deletion deferred until undo window expires
```

#### Pattern B: Confirm for Photo Blocks

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠️ Delete Photo Group?                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  This will remove the photo group block.                    │
│  The photos themselves won't be deleted from the album.     │
│                                                             │
│                                     [Cancel]  [Delete]      │
└─────────────────────────────────────────────────────────────┘

- Only for blocks referencing photos (clarity: photos stay in album)
- Text/heading blocks delete immediately with undo
```

### 2.5 Block Context Menu

Right-click or tap (...) button:

```
┌──────────────────────────┐
│ ↑ Move Up               │
│ ↓ Move Down             │
├──────────────────────────┤
│ 📋 Duplicate             │
│ 🔗 Copy Link             │
├──────────────────────────┤
│ 📝 Turn into...  →       │  ┌────────────────┐
│                          │  │ Text           │
│                          │  │ Heading 1      │
│                          │  │ Heading 2      │
│                          │  │ Heading 3      │
│                          │  └────────────────┘
├──────────────────────────┤
│ 🗑️ Delete                │
└──────────────────────────┘
```

---

## 3. Photo-Specific UX

### 3.1 Photo Integration Philosophy

**Decision: Photos exist at two levels**

1. **Album-level Gallery** — All photos, grid view (existing)
2. **Story Blocks** — Curated selection with narrative context

```
┌─────────────────────────────────────────────────────────────┐
│  🏠 Iceland 2025                            [Grid] [Story] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Grid mode]                    [Story mode]                │
│  ┌────┬────┬────┬────┐         # Day 1: Arrival            │
│  │ 📷 │ 📷 │ 📷 │ 📷 │         We landed at...             │
│  ├────┼────┼────┼────┤         [📷 📷 📷] ← Photo Group    │
│  │ 📷 │ 📷 │ 📷 │ 📷 │                                     │
│  ├────┼────┼────┼────┤         ## The Blue Lagoon          │
│  │ 📷 │ 📷 │ 📷 │ 📷 │         The famous geothermal...   │
│  └────┴────┴────┴────┘                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Toggle between grid (all photos) and story (blocks) views
```

### 3.2 Adding Photos to Story

#### Option A: Pick from Gallery (Recommended)

```
┌─────────────────────────────────────────────────────────────┐
│  Select photos for this group                    [Done]     │
├─────────────────────────────────────────────────────────────┤
│  📍 Filter: All | Northern Lights | Reykjavik | ...        │
├─────────────────────────────────────────────────────────────┤
│  ┌────┬────┬────┬────┬────┬────┐                           │
│  │ ✓📷│ ✓📷│  📷│  📷│  📷│  📷│   Selected: 2            │
│  ├────┼────┼────┼────┼────┼────┤                           │
│  │  📷│  📷│  📷│  📷│  📷│  📷│                           │
│  └────┴────┴────┴────┴────┴────┘                           │
│                                                             │
│  ← Shows album photos, checkmark to select, tap to toggle  │
│                                                             │
└─────────────────────────────────────────────────────────────┘

- Opens as modal/sheet
- Multi-select with checkmarks
- Filters by date, location (existing metadata)
- "Done" creates PhotoGroup block
```

#### Option B: Drag from Sidebar

```
┌─────────────────────────────────────────────────────────────┐
│  Story View                          │ Photo Tray          │
├──────────────────────────────────────┤─────────────────────┤
│                                      │ ┌────┐ ┌────┐       │
│  # Day 1                             │ │ 📷 │ │ 📷 │ ←drag │
│                                      │ └────┘ └────┘       │
│  Text here...                        │ ┌────┐ ┌────┐       │
│                                      │ │ 📷 │ │ 📷 │       │
│  ┌──────────────────────────────────┐│ └────┘ └────┘       │
│  │      Drop photos here            ││                     │
│  │      to create photo group       ││ All photos from     │
│  └──────────────────────────────────┘│ this album          │
│                                      │                     │
└─────────────────────────────────────────────────────────────┘

- Desktop only (not touch-friendly)
- Useful for power users
- Collapsible sidebar
```

### 3.3 PhotoGroup Configuration

After creating a PhotoGroup, double-click/tap to configure:

```
┌─────────────────────────────────────────────────────────────┐
│  Photo Group Settings                                 [✕]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Layout                                                     │
│  ╔═══════╗  ┌───────┐  ┌───────┐  ┌───────┐               │
│  ║ Grid  ║  │Masonry│  │Carousel│ │ Row   │               │
│  ╚═══════╝  └───────┘  └───────┘  └───────┘               │
│                                                             │
│  Columns (for Grid)                                         │
│  [ 2 ]  [●3 ]  [ 4 ]                                       │
│                                                             │
│  Title (optional)                                           │
│  [Northern Lights Photos                    ]               │
│                                                             │
│  Photos in this group                                       │
│  ┌────┬────┬────┐                                          │
│  │ 📷 │ 📷 │ 📷 │  [+ Add] [🗑️ Remove selected]           │
│  └────┴────┴────┘                                          │
│                                                             │
│                               [Cancel]  [Save Changes]      │
└─────────────────────────────────────────────────────────────┘
```

### 3.4 Single PhotoRef Block

For featured/hero images:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                                                        │ │
│  │                    🏔️ LARGE PHOTO                      │ │
│  │                                                        │ │
│  │                                                        │ │
│  ├────────────────────────────────────────────────────────┤ │
│  │ Caption: Golden Circle at sunset             [Edit ✏️] │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ← Single photo with optional caption                       │
│  ← Click photo to view full-size in lightbox               │
│  ← Click Edit to change photo or caption                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.5 Cover Photo Selection

From Story view, any PhotoRef can become cover:

```
Right-click on PhotoRef block:
┌──────────────────────────┐
│ 📌 Set as Album Cover    │ ← New option
│ ✏️ Edit Caption          │
│ 🔍 View Full Size        │
│ 🗑️ Remove from Story    │
└──────────────────────────┘
```

---

## 4. Rich Text Editing

### 4.1 Formatting Scope

**Recommendation: Minimal but polished**

| Feature | Include? | Rationale |
|---------|----------|-----------|
| **Bold** | ✅ Yes | Essential for emphasis |
| **Italic** | ✅ Yes | Essential for titles, foreign words |
| **Links** | ✅ Yes | Reference external sites |
| **Strikethrough** | ❌ No | Not needed for photo stories |
| **Code** | ❌ No | Not a dev tool |
| **Bullet lists** | ⚠️ Maybe | Useful for captions, keep simple |
| **Numbered lists** | ⚠️ Maybe | Less common for narratives |
| **Quote blocks** | ✅ Yes | Good for pull quotes |
| **Tables** | ❌ No | Too complex for photo albums |

### 4.2 Formatting Methods

#### Method 1: Inline Formatting Toolbar

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  We visited the |famous| Blue Lagoon     ← Select text     │
│               ┌──────────────────────┐                      │
│               │ B  I  🔗  "  ...     │   ← Toolbar appears │
│               └──────────────────────┘                      │
│                                                             │
│  - Appears on text selection                                │
│  - Floats above selected text                               │
│  - Disappears on click outside                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Method 2: Markdown Shortcuts

| Typed | Result |
|-------|--------|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `[text](url)` | linked text |
| `> quote` | blockquote |
| `# heading` | H1 (at line start) |
| `## heading` | H2 |
| `### heading` | H3 |

**Implementation:** Convert on space/enter, not on every keystroke.

### 4.3 Link Editing

```
┌─────────────────────────────────────────────────────────────┐
│  Click link to edit:                                        │
│                                                             │
│  Visit [Blue Lagoon] for tickets                            │
│        └──────────────────────────────────────────────┐     │
│        │ https://www.bluelagoon.com                   │     │
│        │ ─────────────────────────────                │     │
│        │ [📋 Copy] [🔗 Open] [✏️ Edit] [🗑️ Remove]   │     │
│        └──────────────────────────────────────────────┘     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.4 Quote Block Style

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┃ "The Northern Lights danced across the sky like         │
│  ┃  nothing I'd ever seen."                                │
│  ┃                                                         │
│  ┃  — Travel Journal, Day 3                                │
│                                                             │
│  ← Blue left border, slightly indented                      │
│  ← Optional attribution line                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Mobile Considerations

### 5.1 Touch Interaction Patterns

| Action | Desktop | Mobile |
|--------|---------|--------|
| Select block | Click | Tap |
| Edit text | Click into | Tap into |
| Show menu | Hover/right-click | Long-press |
| Add block | Hover (+) or `/` | FAB button |
| Reorder | Drag handle | Long-press + drag |
| Multi-select | Ctrl+click | Enter select mode |

### 5.2 Mobile Block Reordering

**Challenge:** Touch drag-and-drop is problematic with scrolling.

**Solution: Explicit Reorder Mode**

```
┌─────────────────────────────────────────────────────────────┐
│  Story                              [Done]  ← Exit reorder │
│  ──────────────────────────────────────────                │
├─────────────────────────────────────────────────────────────┤
│  ≡  # Day 1: Arrival                         ┌──┐          │
│  ≡  Text block here...                       │ ≡│ drag     │
│  ≡  [📷 Photo Group]                         │  │ handles  │
│  ≡  More text...                             └──┘          │
│                                                             │
│  Drag handles on left, or use ↑↓ buttons                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Entry: Menu → "Reorder Blocks" or long-press any block
Exit: "Done" button or tap outside
```

### 5.3 Virtual Keyboard Handling

```
┌─────────────────────────────────────────────────────────────┐
│  # Day 1                                                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  We landed at Keflavik|                                     │
│                                                             │
│─────────────────────────────────────────────────────────────│
│  [B] [I] [🔗] [@] [📷]    ← Toolbar above keyboard         │
│─────────────────────────────────────────────────────────────│
│  Q W E R T Y U I O P                                       │
│  A S D F G H J K L                                         │
│  ⬆️ Z X C V B N M ⌫                                         │
│  🌐 , [    space    ] . ↩️                                  │
└─────────────────────────────────────────────────────────────┘

- Formatting toolbar fixed above keyboard
- Scrolls content so caret is visible
- "Done" button in toolbar area on iOS
```

### 5.4 Mobile Add Block Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Story                                                      │
│  ──────────────                                            │
│                                                             │
│  # Day 1                                                    │
│                                                             │
│  Some text here...                                          │
│                                                             │
│                                           ┌─────┐           │
│                                           │  +  │  ← FAB   │
│                                           └─────┘           │
└─────────────────────────────────────────────────────────────┘
            │
            ▼ Tap FAB
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Add Block                            ││
│  ├─────────────────────────────────────────────────────────┤│
│  │  📝 Text                                                ││
│  │  📢 Heading                                             ││
│  │  🖼️ Photo                                                ││
│  │  📷 Photo Group                                         ││
│  │  📍 Map                                                 ││
│  │  📅 Date Marker                                         ││
│  │  ── Divider                                             ││
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Bottom sheet with block types                              │
│  Swipe down or tap outside to dismiss                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 Responsive Breakpoints

| Screen Width | Layout Adjustments |
|--------------|-------------------|
| < 480px (Mobile) | FAB for add, bottom sheets, full-width blocks |
| 480-768px (Tablet) | Floating add button, side panels |
| > 768px (Desktop) | Hover controls, inline menus, keyboard shortcuts |

---

## 6. Onboarding and Empty States

### 6.1 Empty Album (New Album, No Content)

```
┌─────────────────────────────────────────────────────────────┐
│  📷 Iceland 2025                                    [⚙️]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│                                                             │
│           ┌─────────────────────────────────────┐           │
│           │                                     │           │
│           │         📷 ➕ 📝                     │           │
│           │                                     │           │
│           │    Start your photo story           │           │
│           │                                     │           │
│           │  Upload photos or add your first    │           │
│           │  block to begin telling your story  │           │
│           │                                     │           │
│           │  [📤 Upload Photos]  [📝 Add Text] │           │
│           │                                     │           │
│           │  ─────── or ───────                 │           │
│           │                                     │           │
│           │  [✨ Start from Template]           │           │
│           │                                     │           │
│           └─────────────────────────────────────┘           │
│                                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Template Selection

```
┌─────────────────────────────────────────────────────────────┐
│  Choose a Template                                    [✕]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐          │
│  │ 🗺️                  │  │ 🎉                  │          │
│  │                     │  │                     │          │
│  │   Travel Story      │  │   Event Album       │          │
│  │                     │  │                     │          │
│  │ Dates, maps,        │  │ Timeline,           │          │
│  │ locations           │  │ highlights          │          │
│  └─────────────────────┘  └─────────────────────┘          │
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐          │
│  │ 📖                  │  │ ⬜                  │          │
│  │                     │  │                     │          │
│  │   Photo Journal     │  │   Blank              │          │
│  │                     │  │                     │          │
│  │ Daily entries       │  │ Start from          │          │
│  │ with captions       │  │ scratch             │          │
│  └─────────────────────┘  └─────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Template Structures

**Travel Story Template:**
```markdown
# [Trip Name]

📅 [Start Date] — [End Date]

## Day 1: Arrival

[Add your arrival story and photos here]

---

## Day 2

[Continue your adventure...]

📍 [Map block with trip locations]
```

**Event Album Template:**
```markdown
# [Event Name]

📅 [Event Date]

[Photo group: Key moments]

## Highlights

[Add text and photos]

## People

[Photo group: Attendees]
```

### 6.4 First-Time User Hints

On first edit after template selection:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  # Trip Name ← Click here to edit                          │
│    ↑                                                        │
│   ┌──────────────────────────────────────┐                  │
│   │ 💡 Click any text to start editing   │                  │
│   │    Type / to add new blocks          │                  │
│   │                        [Got it]      │                  │
│   └──────────────────────────────────────┘                  │
│                                                             │
│  📅 January 2025                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘

- Non-modal hint bubble
- Dismisses permanently once clicked
- Store in localStorage: `mosaic_onboarding_complete`
```

---

## 7. Component Recommendations

### 7.1 Rich Text Editor: TipTap

**Recommendation: [TipTap](https://tiptap.dev/) (MIT, built on ProseMirror)**

| Criteria | TipTap | Slate.js | Lexical |
|----------|--------|----------|---------|
| **React 19** | ✅ Compatible | ✅ Compatible | ✅ Compatible |
| **Bundle size** | ~60KB | ~80KB | ~40KB |
| **Extensibility** | ✅✅ Excellent | ✅ Good | ✅ Good |
| **Custom blocks** | ✅ NodeView | ✅ Plugins | ✅ Plugins |
| **Collaborative** | ✅ Y.js built-in | ⚠️ Manual | ⚠️ Manual |
| **Documentation** | ✅✅ Excellent | ✅ Good | ⚠️ Growing |
| **Maintenance** | ✅ Active | ✅ Active | ✅ Meta-backed |

**Why TipTap:**
1. Excellent block-level customization via NodeViews
2. Built-in Y.js support (for future collaboration)
3. Headless architecture fits Mosaic's custom styling
4. TypeScript-first
5. Active community and commercial support

### 7.2 Integration Pattern

```typescript
// TipTap + Custom Blocks
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { PhotoGroupExtension } from './extensions/photo-group';
import { MapBlockExtension } from './extensions/map-block';

const editor = useEditor({
  extensions: [
    StarterKit,
    PhotoGroupExtension,  // Custom NodeView
    MapBlockExtension,    // Custom NodeView
  ],
  content: decryptedBlocks, // Render from block data
});
```

### 7.3 Block Renderers as NodeViews

```typescript
// Custom TipTap NodeView for PhotoGroup
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react';

function PhotoGroupView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="photo-group-block">
      <MosaicPhotoGrid
        manifestIds={node.attrs.manifestIds}
        layout={node.attrs.layout}
        onLayoutChange={(layout) => updateAttributes({ layout })}
      />
    </NodeViewWrapper>
  );
}
```

### 7.4 Drag and Drop: @dnd-kit

**Recommendation: [@dnd-kit/core](https://dndkit.com/)**

| Criteria | @dnd-kit | react-beautiful-dnd | react-dnd |
|----------|----------|---------------------|-----------|
| **React 19** | ✅ | ⚠️ Deprecated | ✅ |
| **Touch support** | ✅✅ Native | ✅ | ⚠️ Limited |
| **Accessibility** | ✅✅ ARIA | ✅ | ⚠️ |
| **Keyboard** | ✅ Built-in | ✅ | ❌ Manual |
| **Bundle size** | ~13KB | ~30KB | ~20KB |

**Why @dnd-kit:**
1. Built for React, not ported
2. Excellent touch and keyboard support
3. Modular (only import what you need)
4. Works smoothly with virtualized lists

### 7.5 Photo Picker Modal

Use existing Mosaic Dialog component with new content:

```typescript
// Reuse existing pattern
import { Dialog } from '../Shared/Dialog';

function PhotoPickerDialog({ 
  isOpen, 
  onClose, 
  onSelect,
  albumId 
}: PhotoPickerDialogProps) {
  const { photos } = usePhotoList(albumId);
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Select Photos">
      <PhotoGrid 
        photos={photos} 
        selectable 
        selected={selected}
        onToggle={(id) => /* toggle selection */}
      />
      <footer>
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => onSelect(selected)}>
          Add {selected.length} Photos
        </button>
      </footer>
    </Dialog>
  );
}
```

---

## 8. Wireframe Descriptions

### 8.1 Story View - Desktop

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back   Iceland 2025                         [Grid] [Story] [⚙️] [📤] │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │                          COVER PHOTO                              │  │
│  │                         (full width)                              │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Story Content ───────────────────────────────────────────────────┐  │
│  │                                                                   │  │
│  │  ⋮⋮ │ # Our Iceland Adventure                                    │  │
│  │     │                                                             │  │
│  │ (+) │ 📅 January 15-22, 2025                                     │  │
│  │     │                                                             │  │
│  │  ⋮⋮ │ We'd been dreaming of Iceland for years...                 │  │
│  │     │                                                             │  │
│  │  ⋮⋮ │ ┌──────────────────────────────────────────────────────┐   │  │
│  │     │ │ [📷] [📷] [📷] [📷]   Photo Group: Arrival           │   │  │
│  │     │ │  (4 photos in grid layout)                            │   │  │
│  │     │ └──────────────────────────────────────────────────────┘   │  │
│  │     │                                                             │  │
│  │  ⋮⋮ │ ## Day 1: The Blue Lagoon                                  │  │
│  │     │                                                             │  │
│  │  ⋮⋮ │ ┌──────────────────────────────────────────────────────┐   │  │
│  │     │ │         📍 Map showing Blue Lagoon location           │   │  │
│  │     │ └──────────────────────────────────────────────────────┘   │  │
│  │     │                                                             │  │
│  │  ⋮⋮ │ The geothermal waters were incredible...                   │  │
│  │     │                                                             │  │
│  └─────│─────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Elements:                                                              │
│  - Drag handles (⋮⋮) appear on hover                                   │
│  - Add button (+) appears between blocks on hover                       │
│  - Content centered, max-width 720px on desktop                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Story View - Mobile

```
┌───────────────────────────┐
│  ← Iceland 2025     [⋮]  │
├───────────────────────────┤
│ [Grid] [Story]            │
├───────────────────────────┤
│ ┌───────────────────────┐ │
│ │                       │ │
│ │    COVER PHOTO        │ │
│ │                       │ │
│ └───────────────────────┘ │
│                           │
│ # Our Iceland Adventure   │
│                           │
│ 📅 Jan 15-22, 2025        │
│                           │
│ We'd been dreaming...     │
│                           │
│ ┌────┬────┐               │
│ │ 📷 │ 📷 │               │
│ ├────┼────┤  Photo Group  │
│ │ 📷 │ 📷 │               │
│ └────┴────┘               │
│                           │
│ ## Day 1: The Blue...     │
│                           │
│              ┌──────┐     │
│              │  +   │ FAB │
│              └──────┘     │
└───────────────────────────┘

- Full-width layout
- FAB for adding blocks
- Long-press for context menu
```

### 8.3 Block Selection State

```
┌─────────────────────────────────────────────────────────────┐
│  ─────── Selection Mode: 3 blocks selected ───────         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ✓ # Heading block                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ✓ Paragraph block selected...                         │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ✓ [Photo Group]                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │   More text not selected                              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [✕ Cancel]              [🗑️ Delete 3]  [📋 Duplicate]     │
└─────────────────────────────────────────────────────────────┘

- Selected blocks have blue border + light blue background
- Action bar at bottom
- Escape to exit selection mode
```

---

## 9. Keyboard Shortcuts

### 9.1 Navigation

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Move between blocks |
| `Tab` | Move to next block |
| `Shift + Tab` | Move to previous block |
| `Escape` | Deselect / exit editing |
| `Enter` | Enter block / new line |

### 9.2 Editing

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + B` | Bold |
| `Ctrl/Cmd + I` | Italic |
| `Ctrl/Cmd + K` | Insert/edit link |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |

### 9.3 Block Operations

| Shortcut | Action |
|----------|--------|
| `/` | Open block menu (at line start) |
| `Ctrl/Cmd + Shift + ↑` | Move block up |
| `Ctrl/Cmd + Shift + ↓` | Move block down |
| `Ctrl/Cmd + D` | Duplicate block |
| `Delete` / `Backspace` | Delete empty block |
| `Ctrl/Cmd + A` | Select all blocks |
| `Shift + ↑/↓` | Extend selection |

### 9.4 Discoverability

Show keyboard shortcuts via:
1. Tooltip on hover (e.g., "Bold (Ctrl+B)")
2. Help modal (`?` key when not editing)
3. Menu items show shortcuts inline

---

## 10. Accessibility

### 10.1 ARIA Landmarks

```html
<main role="main" aria-label="Album story editor">
  <article role="article" aria-label="Story content">
    <div role="region" aria-label="Block 1: Heading">
      <!-- Block content -->
    </div>
    <div role="region" aria-label="Block 2: Paragraph">
      <!-- Block content -->
    </div>
  </article>
</main>
```

### 10.2 Focus Management

| Scenario | Focus Behavior |
|----------|----------------|
| Add block | Focus new block |
| Delete block | Focus previous block (or next if first) |
| Open menu | Focus first menu item |
| Close menu | Return focus to trigger element |
| Modal open | Trap focus within modal |
| Modal close | Return focus to trigger |

### 10.3 Screen Reader Announcements

```typescript
// Announce block operations
function announceAction(action: string) {
  const liveRegion = document.getElementById('sr-announcer');
  if (liveRegion) {
    liveRegion.textContent = action;
  }
}

// Usage
announceAction('Block added: Photo group');
announceAction('Block moved to position 3');
announceAction('2 blocks deleted. Press Ctrl+Z to undo.');
```

### 10.4 Color Contrast

| Element | Foreground | Background | Ratio |
|---------|------------|------------|-------|
| Body text | #1a1a1a | #ffffff | 16:1 ✅ |
| Selection | #1a1a1a | #e6f0ff | 14:1 ✅ |
| Placeholder | #6b7280 | #ffffff | 4.6:1 ✅ |
| Error | #dc2626 | #ffffff | 4.5:1 ✅ |

### 10.5 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  .block-dragging,
  .block-transition {
    animation: none;
    transition: none;
  }
}
```

---

## Appendix A: Component Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        StoryEditor (main container)                     │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │   TipTap Core    │    │  BlockRegistry   │    │  CommandPalette  │  │
│  │   (rich text)    │    │  (block types)   │    │  (slash menu)    │  │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘  │
│           │                       │                       │            │
│  ┌────────▼─────────────────────▼─────────────────────────▼──────────┐│
│  │                         BlockRenderer                              ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ││
│  │  │TextBlock │ │Heading   │ │PhotoGroup│ │MapBlock  │ │Timeline  │ ││
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ ││
│  └───────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                      DndKit Context                              │  │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │  │
│  │  │ DragHandle    │  │ DropZone      │  │ SortableBlock │        │  │
│  │  └───────────────┘  └───────────────┘  └───────────────┘        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                      Dialogs/Sheets                              │  │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │  │
│  │  │ PhotoPicker   │  │ GroupConfig   │  │ MapConfig     │        │  │
│  │  └───────────────┘  └───────────────┘  └───────────────┘        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix B: State Management

```typescript
// Story editor state using Zustand
interface StoryEditorState {
  // Content
  blocks: Block[];
  rootBlockIds: string[];
  
  // Selection
  selectedBlockIds: Set<string>;
  focusedBlockId: string | null;
  
  // Edit state
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAt: Date | null;
  
  // UI state
  showCommandPalette: boolean;
  commandPalettePosition: { x: number; y: number };
  draggedBlockId: string | null;
  
  // Actions
  addBlock: (type: BlockType, afterId?: string) => void;
  updateBlock: (id: string, content: BlockContent) => void;
  deleteBlocks: (ids: string[]) => void;
  moveBlock: (id: string, newPosition: string) => void;
  selectBlock: (id: string, additive?: boolean) => void;
  deselectAll: () => void;
  save: () => Promise<void>;
  undo: () => void;
  redo: () => void;
}
```

---

## Appendix C: Package Additions

```json
{
  "dependencies": {
    "@tiptap/react": "^2.2.0",
    "@tiptap/starter-kit": "^2.2.0",
    "@tiptap/extension-link": "^2.2.0",
    "@tiptap/extension-placeholder": "^2.2.0",
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "fractional-indexing": "^3.2.0"
  }
}
```

**Bundle impact estimate:**
- TipTap core: ~60KB gzipped
- @dnd-kit: ~15KB gzipped
- fractional-indexing: ~1KB gzipped
- **Total: ~76KB** (acceptable for this feature scope)

---

## Appendix D: Implementation Priorities

### Phase 1: Core Editor (MVP)

1. TipTap integration with basic text editing
2. Heading block (H1, H2, H3)
3. Slash command menu (`/`)
4. Basic block selection (single)
5. Drag-and-drop reordering (desktop)
6. Delete with undo toast

### Phase 2: Photo Integration

7. PhotoRef block with photo picker
8. PhotoGroup block with grid layout
9. Caption editing
10. Cover photo selection from story

### Phase 3: Rich Features

11. Map block with Leaflet
12. Timeline/date markers
13. Quote blocks
14. Multi-block selection
15. Templates

### Phase 4: Polish

16. Mobile block reordering (reorder mode)
17. Keyboard shortcuts
18. Accessibility audit
19. Onboarding flows
20. Performance optimization (virtualization if needed)

---

**End of Specification**
