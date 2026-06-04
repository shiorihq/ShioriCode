This local target vendors the small AppKit permission-guide helper from
https://github.com/zats/permiso at revision
3012871b741f68b1b6f46e2e1936c422df703968.

The upstream package manifest currently declares a macOS 26 deployment target.
ShioriCode keeps the source local so the Computer Use helper can build for the
desktop app's supported macOS range while preserving the permiso UI approach.
