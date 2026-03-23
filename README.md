# SystemLink App Store

> **⚠️ Preview & Unofficial** — This is a community preview project and **not a released or supported NI product**. It is provided as-is, without warranty of any kind. Features may change or be removed without notice. **Use at your own risk.**

A curated marketplace for [NI SystemLink](https://www.ni.com/en/shop/electronic-test-instrumentation/application-software-for-electronic-test-and-instrumentation-category/what-is-systemlink.html) custom web apps, notebooks, and extensibility packages. Users can browse, install, upgrade, and remove apps from both a webapp embedded inside SystemLink and the `slcli` command-line interface.

## How it works

The catalog is hosted as a standard NI Package Manager (nipkg) feed on GitHub:

- **Package index** — served via GitHub Pages (`Packages` / `Packages.gz`)
- **Package binaries** — distributed as `.nipkg` files attached to GitHub Releases
- **Replication** — a SystemLink Feed Service replicates the GitHub Pages feed locally so the webapp can operate within SystemLink's strict Content Security Policy (CSP)

Publishing is **curated**: all submissions go through a PR-based review process that includes functional testing and a security audit.

## Repository structure

| Path              | Description                               |
| ----------------- | ----------------------------------------- |
| `webapp/`         | Angular app embedded inside SystemLink    |
| `submissions/`    | Community app submissions (PR-based)      |
| `scripts/`        | Feed index rebuild and submission helpers |
| `docs/`           | GitHub Pages doc site                     |
| `Packages`        | Debian-style nipkg feed index             |
| `CONTRIBUTING.md` | How to submit an app                      |
| `REQUIREMENTS.md` | Full architecture and requirements        |

## Getting started

See [CONTRIBUTING.md](CONTRIBUTING.md) to submit an app, or visit the [doc site](https://ni-kismet.github.io/systemlink-app-store/) for an overview.

To develop the webapp locally:

```bash
cd webapp
npm install
ng serve
```

## License

MIT — see [LICENSE](LICENSE) for details (where present per package).
