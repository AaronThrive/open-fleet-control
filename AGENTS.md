# AGENTS.md — AI Workspace Guide

> *"The Overmind speaks through many voices, but with one purpose."*

Welcome, AI agent. This document defines how you should interact with this codebase.

## 🎯 Mission

MoltBot Command Center is the central dashboard for AI assistant management. Your mission is to help build, maintain, and improve this system while maintaining the Starcraft/Zerg thematic elements that make it unique.

## 📁 Workspace Structure

```
openclaw-command-center/
├── lib/                    # YOUR DOMAIN — Core logic lives here
│   ├── api/               # Express routes
│   ├── services/          # Business logic
│   └── utils/             # Helpers
├── public/                 # Frontend assets
├── docs/                   # Documentation
├── config/                 # Configuration (be careful!)
└── .github/               # CI/CD and templates
```

## ✅ Safe Operations

Do freely:
- Read any file to understand the codebase
- Create/modify files in `lib/`, `public/`, `docs/`
- Add tests
- Update documentation
- Create feature branches

## ⚠️ Ask First

Check with a human before:
- Modifying `config/` files
- Changing CI/CD workflows
- Adding new dependencies to `package.json`
- Making breaking API changes
- Anything touching authentication/secrets

## 🚫 Never

- Commit secrets, API keys, or credentials
- Delete files without confirmation
- Push directly to `main` branch
- Expose internal endpoints publicly

## 🛠️ Development Workflow

### 1. Feature Development
```bash
# Create feature branch
git checkout -b feature/your-feature-name

# Make changes
# ...

# Test locally
npm test
npm run lint

# Commit with descriptive message
git commit -m "feat: add overlord status indicator"

# Push and create PR
git push -u origin feature/your-feature-name
```

### 2. Commit Message Convention
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `style:` — Formatting, no code change
- `refactor:` — Code restructuring
- `test:` — Adding tests
- `chore:` — Maintenance tasks

### 3. Code Style
- Use ESLint configuration provided
- Prettier for formatting
- JSDoc comments for public functions
- Meaningful variable names (thematic names encouraged!)

## 🎨 Thematic Guidelines

This project has a Starcraft/Zerg theme. When naming things:

| Concept | Thematic Name |
|---------|---------------|
| Main controller | Overmind |
| Worker processes | Drones |
| Monitoring service | Overlord |
| Cache layer | Creep |
| Message queue | Spawning Pool |
| Health check | Essence scan |
| Error state | Corrupted |

Example:
```javascript
// Instead of: const cacheService = new Cache();
const creepLayer = new CreepCache();

// Instead of: function checkHealth()
function scanEssence()
```

## 📝 Documentation Standards

When you add features, document them:

1. **Code comments** — JSDoc for functions
2. **README updates** — If user-facing
3. **API docs** — In `docs/api/` for endpoints
4. **Architecture Decision Records** — In `docs/architecture/` for major changes

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- lib/services/overlord.test.js

# Coverage report
npm run test:coverage
```

Aim for meaningful test coverage. Test the logic, not the framework.

## 🐛 Debugging

The project uses debug namespaces:
```bash
# Enable all command-center debug output
DEBUG=openclaw:* npm run dev

# Specific namespaces
DEBUG=openclaw:api npm run dev
DEBUG=openclaw:overlord npm run dev
```

## 🔄 Handoff Protocol

When handing off to another AI or ending a session:

1. Commit all work in progress
2. Document current state in a comment or commit message
3. List any unfinished tasks
4. Note any decisions that need human input

## 📚 Key Resources

- [SOUL.md](./SOUL.md) — Project personality and values
- [USER.md](./USER.md) — Human operator context
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [docs/](./docs/) — Detailed documentation

---

*"Awaken, my child, and embrace the glory that is your birthright."*
