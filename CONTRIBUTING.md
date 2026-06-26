# Contributing to `@elasticfunnels/cli`

## Development

```bash
git clone https://github.com/elasticfunnels/cli.git
cd cli
npm install
npm run watch       # incremental tsc
node bin/ef.js ...  # run from source without npm link
npm test            # full test suite (zero deps, uses node --test)
npm run lint        # eslint over src/
```

`npm link` adds an `ef` to your PATH that points at your working tree.

## Publishing to npm

The package is published as `@elasticfunnels/cli` on the public npm registry.
GitHub hosts the source; npm ships only the compiled `out/` tree (see the
`files` allowlist in `package.json`).

### One-time setup

1. Make sure you're a member of the `@elasticfunnels` npm org:
   ```bash
   npm whoami
   npm org ls elasticfunnels
   ```
2. Confirm `LICENSE` exists (it ships with the package).

### Pre-publish checklist

`prepublishOnly` runs lint + tests + a fresh build automatically, but you can
also drive each step by hand to catch issues before pushing a tag:

```bash
npm ci                     # clean install
npm run lint               # eslint over src/
npm test                   # full test suite
npm run release:dry        # `npm pack --dry-run` — prints what would ship
```

The dry-run output should show only `bin/ef.js`, the compiled `out/` tree, the
bundled `assets/ef-syntax-*.vsix` (the editor highlighting extension, built by
`npm run build:ext`), `README.md`, `LICENSE`, and `package.json`. If you see
`src/`, `test/`, or `out-test/`, fix `files` / `.npmignore` before continuing.

### Cutting a release

```bash
# Bump the version (npm writes package.json + package-lock.json + a tag)
npm version patch          # 0.2.0 → 0.2.1; use minor / major as appropriate

# Publish. `prepublishOnly` re-runs lint + tests + build first.
npm run release:publish    # npm publish --access public
```

For pre-release candidates use a dist-tag so users on `latest` aren't pulled
onto an unstable build:

```bash
npm version prerelease --preid=rc      # 0.2.1 → 0.2.2-rc.0
npm publish --access public --tag next
```

Promoting an `rc` to `latest`:

```bash
npm dist-tag add @elasticfunnels/cli@0.2.0 latest
```

### Verifying a published install

```bash
mkdir /tmp/ef-smoke && cd /tmp/ef-smoke
npm i -g @elasticfunnels/cli
ef --version
ef --help
ef init --api-url https://app.elasticfunnels.io
```
