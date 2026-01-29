# Contributing to MoltBot Command Center

> *"Join the Swarm. Evolve together."*

First off, thank you for considering contributing to MoltBot Command Center! This project thrives on community involvement.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Contributions](#making-contributions)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)
- [For AI Contributors](#for-ai-contributors)

## 📜 Code of Conduct

This project adheres to our [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you're expected to uphold this code. Please report unacceptable behavior to the maintainers.

## 🚀 Getting Started

### Prerequisites

- Node.js v20 or higher
- npm v10 or higher
- Git

### Development Setup

1. **Fork the repository**
   
   Click the "Fork" button on GitHub to create your own copy.

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/openclaw-command-center.git
   cd openclaw-command-center
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/jontsai/openclaw-command-center.git
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Create configuration**
   ```bash
   cp config/dashboard.example.json config/dashboard.json
   ```

6. **Start development server**
   ```bash
   npm run dev
   ```

## 🛠️ Making Contributions

### Types of Contributions

We welcome:
- 🐛 Bug fixes
- ✨ New features
- 📚 Documentation improvements
- 🧪 Test coverage
- 🎨 UI/UX enhancements
- 🔧 Performance optimizations

### Before You Start

1. **Check existing issues** — Someone might already be working on it
2. **Open an issue first** — For major changes, discuss before implementing
3. **Keep scope focused** — One feature/fix per PR

### Branch Naming

Use descriptive branch names:
```
feature/add-session-filtering
fix/overlord-connection-timeout
docs/update-api-reference
refactor/simplify-creep-cache
```

## 📤 Pull Request Process

### 1. Create Your Branch
```bash
git checkout main
git pull upstream main
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes
- Write clean, documented code
- Add tests for new functionality
- Update documentation if needed
- Follow the [style guidelines](#style-guidelines)

### 3. Test Your Changes
```bash
npm test
npm run lint
```

### 4. Commit Your Changes
Follow [Conventional Commits](https://www.conventionalcommits.org/):
```bash
git commit -m "feat: add overlord heartbeat indicator"
git commit -m "fix: resolve session timeout on reconnect"
git commit -m "docs: clarify API authentication flow"
```

### 5. Push and Create PR
```bash
git push origin feature/your-feature-name
```
Then open a Pull Request on GitHub.

### 6. PR Review

- Maintainers will review your PR
- Address any requested changes
- Once approved, a maintainer will merge

### PR Checklist

Before submitting, ensure:
- [ ] Code follows project style guidelines
- [ ] Tests pass locally (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Documentation updated if needed
- [ ] Commit messages follow convention
- [ ] PR description explains the change

## 🎨 Style Guidelines

### Code Style

- Use ESLint configuration provided
- Use Prettier for formatting
- Prefer `const` over `let`, avoid `var`
- Use meaningful variable names
- Add JSDoc comments for public functions

### Thematic Naming

Embrace the Starcraft theme when naming:
```javascript
// ✅ Good
const overlordStatus = await checkEssence();
const creepCache = new CreepLayer();

// ❌ Less thematic
const monitorStatus = await healthCheck();
const cacheLayer = new CacheService();
```

See [SOUL.md](./SOUL.md) for the full thematic guide.

### Documentation

- Use clear, concise language
- Include code examples where helpful
- Keep README and docs in sync with code
- Add inline comments for complex logic

## 🤖 For AI Contributors

AI agents are welcome contributors! If you're an AI working on this project:

1. **Read the context files first**
   - [AGENTS.md](./AGENTS.md) — Your workspace guide
   - [SOUL.md](./SOUL.md) — Project personality
   - [USER.md](./USER.md) — Human operator context

2. **Follow the same PR process** as human contributors

3. **Document your changes thoroughly** — Future AI (and humans) will thank you

4. **When in doubt, ask** — Open an issue to discuss before major changes

## 💬 Getting Help

- **Questions?** Open a GitHub Discussion
- **Found a bug?** Open an Issue
- **Security concern?** Email maintainers directly (don't open public issue)

## 🙏 Recognition

Contributors will be recognized in:
- GitHub Contributors list
- Release notes for significant contributions
- Our eternal gratitude 🐛

---

*"The Swarm welcomes all who serve the greater purpose."*
