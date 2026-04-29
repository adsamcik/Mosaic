# Mosaic Instruction Tree

> **Architecture of GitHub Copilot Instructions**
> 
> This document explains how instructions are organized and when to read each file.
> The goal is to give agents full project context while allowing deep dives into specialized areas.

---

## Instruction Hierarchy

```
.github/
├── copilot-instructions.md    # 🌍 ROOT: Project-wide rules, all agents read this
├── agents.md                  # 🎭 PERSONAS: Specialized agent roles (@security, @test, etc.)
└── .copilotignore             # 🚫 EXCLUSIONS: Files hidden from Copilot context

docs/
├── FEATURES.md                # 📋 FEATURE CATALOG: All implemented features
├── ARCHITECTURE.md            # 🏗️ SYSTEM DESIGN: Technical architecture overview
├── SECURITY.md                # 🔒 SECURITY MODEL: Zero-knowledge design
└── specs/                     # 📝 SPECIFICATIONS: Feature design documents
    └── SPEC-*.md

apps/backend/
└── .instructions.md           # 🔧 BACKEND: .NET 10 specific patterns

apps/web/
├── .instructions.md           # 💻 FRONTEND ROOT: React 19 + Vite patterns
└── src/
    ├── components/.instructions.md  # 🧩 COMPONENTS: UI component patterns
    ├── hooks/.instructions.md       # 🪝 HOOKS: Custom hook patterns
    └── workers/.instructions.md     # ⚙️ WORKERS: Web Worker patterns

apps/android-main/
└── .instructions.md           # 📱 ANDROID APP: Gradle module + Rust UniFFI adapter rules

libs/crypto/
└── .instructions.md           # 🔐 CRYPTO: Cryptography implementation rules

tests/e2e/
└── .instructions.md           # 🧪 E2E TESTS: Test categories and patterns
```

---

## When to Read Each File

### Always Read (Every Task)

| File | Purpose |
|------|---------|
| `.github/copilot-instructions.md` | Core rules, workflow requirements, forbidden patterns |
| `docs/FEATURES.md` | Check if feature exists, find implementation locations |

### Read Based on Task Type

| Task | Additional Files to Read |
|------|--------------------------|
| **Backend work** | `apps/backend/.instructions.md` |
| **Frontend work** | `apps/web/.instructions.md` + relevant subdirectory |
| **Crypto operations** | `libs/crypto/.instructions.md` |
| **E2E testing** | `tests/e2e/.instructions.md` |
| **New feature** | Check `docs/specs/SPEC-*.md` for existing design |
| **Security review** | `docs/SECURITY.md` + `.github/agents.md` (@security-agent) |
| **Testing** | `.github/agents.md` (@test-agent) |
| **Debugging** | "Mosaic Sentinel" section in root instructions |

---

## Instruction File Template

When creating new `.instructions.md` files, use this structure:

```markdown
# [Area Name] - Scoped Instructions

> These instructions apply specifically to files in `[path/]`

## Technology Stack
- List technologies and versions

## Strict Constraints
- Critical rules that must never be violated

## Patterns
- Code examples showing correct patterns

## Anti-Patterns
- Examples of what NOT to do

## Testing Requirements
- How to test code in this area
```

---

## Feature Documentation Workflow

### When Implementing New Features

1. **Before coding:** Check `docs/FEATURES.md` for existing similar features
2. **For complex features:** Create `docs/specs/SPEC-[FeatureName].md` first
3. **After implementing:** Add entry to `docs/FEATURES.md` using the template

### When Modifying Existing Features

1. **Find the feature** in `docs/FEATURES.md`
2. **Follow the links** to implementation files
3. **Update documentation** if behavior changes
4. **Add changelog entry** at bottom of `docs/FEATURES.md`

---

## Specialized Agent Invocation

Use agents from `.github/agents.md` for focused tasks:

```
@security-agent Review the authentication flow in [file]
@test-agent Write unit tests for [component]
@docs-agent Document the [feature] API
@refactor-agent Simplify [file]
@crypto-agent Implement [crypto operation]
@perf-agent Profile [component] with [scenario]
@feature-agent Document the new [feature]
```

---

## Discovery Protocol

When starting work on an unfamiliar area:

1. **Read root instructions** (`.github/copilot-instructions.md`)
2. **Check feature catalog** (`docs/FEATURES.md`) for context
3. **Read scoped instructions** for the relevant `apps/` or `libs/` directory
4. **Check for component-level instructions** in subdirectories
5. **Review existing specs** if working on a documented feature

---

## Maintenance Rules

### Adding New Instruction Files

- Place `.instructions.md` in the directory they govern
- Keep instructions focused on that directory's concerns
- Reference parent instructions, don't duplicate them
- Use the template structure above

### Updating Instructions

- Update when patterns evolve or new constraints emerge
- Keep examples current with actual code
- Remove outdated information promptly
- Ensure consistency across related instruction files

### Documentation Triggers

These events REQUIRE documentation updates:

| Event | Update Required |
|-------|-----------------|
| New feature implemented | Add to `docs/FEATURES.md` |
| Feature behavior changed | Update `docs/FEATURES.md` entry |
| New API endpoint | Update `docs/api/openapi.yaml` |
| Architecture change | Update `docs/ARCHITECTURE.md` |
| Security model change | Update `docs/SECURITY.md` |
| New pattern established | Add to relevant `.instructions.md` |
