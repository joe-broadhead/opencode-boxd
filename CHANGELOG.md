# Changelog

## 0.1.0

- Control plane for private boxd machines, pinned to OpenCode 2.2.6.
- Session handoff is export then import, parents before children. The laptop ledger is the store.
- Destroy and hibernate refuse until that import is proven. A snapshot is an image, not a session.
