// Lucide fallbacks for the `nucleo-ui-outline-18` package.
//
// Like `lucideNucleoFallback.ts`, this stands in for the licensed Nucleo
// package when no Nucleo license key is present. The alias is wired up in
// `vite.config.ts` (runtime) and `tsconfig.json` (types).
//
// The Nucleo UI library is a separate icon set from Nucleo Core, so icons
// that only exist there (e.g. `pin-tack-slash`) are sourced from this
// package rather than `nucleo-core-outline-24`.
export {
  // `pin-tack-slash` — lucide's `PinOff` is itself a slashed pin tack.
  PinOff as IconPinTackSlashOutline18,
} from "lucide-react";
