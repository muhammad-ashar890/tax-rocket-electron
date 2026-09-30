# Tax Rocket Portal Agent — Windows Installer

The Assisted Filing flow has already been tested with the local Electron app. The Windows `.exe` installer is built from here.

A **code-signing certificate is not required** for this development build. Windows SmartScreen may show a warning the first time — select _More info → Run anyway_.

## Build on Windows

First close `npm run dev` and the Electron app. A file lock may cause the build to fail.

```bat
cd path\to\tax-rocket\electron-connect
npm install
npm run dist:win
```
