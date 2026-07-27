import type { CSSProperties } from "react";

/**
 * One implementation of the appearance-background photograph, used for both
 * regions (the app shell behind the sidebar, and the main content pane).
 *
 * The image and its ambient scrim are separate CSS layers (the scrim is the
 * `[data-app-wallpaper]::after` pseudo-element in index.css), so the opacity
 * slider — which drives only the image element here — can never weaken the
 * scrim that guarantees legibility for the chrome floating over it.
 */
export function AppWallpaper(props: {
  region: "shell" | "main";
  url: string;
  /** 0-100 */ opacity: number;
  /** px */ blur: number;
}) {
  return (
    <div aria-hidden="true" data-app-wallpaper={props.region}>
      <div
        data-app-wallpaper-image={props.region}
        style={
          {
            "--app-wallpaper-image": `url(${JSON.stringify(props.url)})`,
            "--app-wallpaper-opacity": props.opacity / 100,
            "--app-wallpaper-blur": `${props.blur}px`,
          } as CSSProperties
        }
      />
    </div>
  );
}
