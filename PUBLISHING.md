# Publishing

This extension publishes as `yousefkadah.claude-session-tabs`. CI and release
are automated via GitHub Actions ([`ci.yml`](.github/workflows/ci.yml),
[`release.yml`](.github/workflows/release.yml)); the one-time human setup is the
Marketplace publisher + token below.

## One-time: create the Marketplace publisher & token

1. **Azure DevOps org** — sign in at <https://dev.azure.com> with the Microsoft
   account you want to own the publisher (any free personal account works).
2. **Personal Access Token (PAT)** — in Azure DevOps → *User settings* →
   *Personal access tokens* → **New Token**:
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined** → **Marketplace** → **Manage**
   - Copy the token (shown once).
3. **Create the publisher** — go to
   <https://marketplace.visualstudio.com/manage> and create a publisher whose
   **ID is `yousefkadah`** (must match `publisher` in [package.json](package.json);
   change both if you use a different id).

## Publish

### Automated (recommended)

1. Add the PAT as a repo secret: **Settings → Secrets and variables → Actions →
   New repository secret**, name **`VSCE_PAT`**. (Optional: `OVSX_PAT` for
   [Open VSX](https://open-vsx.org).)
2. Bump the version and tag:
   ```bash
   npm version patch          # or minor / major — updates package.json + commits
   git push && git push --tags
   ```
   The `Release` workflow then packages the VSIX, attaches it to a GitHub
   Release, and runs `vsce publish` (only if `VSCE_PAT` is set).

### Manual

```bash
npm ci
npm run typecheck && npm test
npx @vscode/vsce login yousefkadah      # paste the PAT once
npx @vscode/vsce publish --no-dependencies
```

Or package locally and upload the `.vsix` by hand at
<https://marketplace.visualstudio.com/manage>:

```bash
npx @vscode/vsce package --no-dependencies
```

## Pre-publish checklist

- `publisher` in `package.json` matches your Marketplace publisher id.
- `version` bumped and `CHANGELOG.md` updated.
- `repository`, `bugs`, `homepage` URLs are correct.
- `README.md` reads well (it becomes the Marketplace page) — add `media/demo.gif`.
- `npm run typecheck && npm test && npm run package` all pass locally.
