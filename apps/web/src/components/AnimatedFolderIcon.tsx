import { cn } from "~/lib/utils";

interface AnimatedFolderIconProps {
  className?: string;
}

// A folder icon that physically "opens" when an ancestor exposes
// `data-popup-open` (Base UI Select trigger). The closed-folder outline is
// hinged along its bottom edge and tilts away via rotateX, while the
// open-folder's back tab and front trapezoid emerge into place — so the
// strokes themselves animate rather than a cross-fade between two icons.
export function AnimatedFolderIcon({ className }: AnimatedFolderIconProps) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-block size-3.5 shrink-0 [perspective:80px]", className)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="miter"
        strokeLinecap="square"
        className="absolute inset-0 size-full overflow-visible"
      >
        {/* Back of the open folder (tab silhouette). Fades in as the lid lifts. */}
        <path
          d="M21 7C21 5.89543 20.1046 5 19 5H13.5L10.5 2H5C3.89543 2 3 2.89543 3 4V7"
          className="opacity-0 transition-opacity duration-200 ease-out in-data-[popup-open]:opacity-100 in-data-[popup-open]:delay-150"
        />
        {/* Open-state front trapezoid. Grows from the back hinge as the lid clears. */}
        <path
          d="M20 21L22 11L2 11L4 21L20 21Z"
          className="origin-top opacity-0 transition-[opacity,transform] duration-200 ease-out [transform-box:fill-box] [transform:scaleY(0.2)] in-data-[popup-open]:opacity-100 in-data-[popup-open]:delay-150 in-data-[popup-open]:[transform:scaleY(1)]"
        />
        {/* Closed-folder outline — hinged at its bottom edge, tilts back like a real lid. */}
        <path
          d="M2 5V18C2 19.1046 2.89543 20 4 20H20C21.1046 20 22 19.1046 22 18V8C22 6.89543 21.1046 6 20 6H13L10 3H4C2.89543 3 2 3.89543 2 5Z"
          className="origin-bottom transition-transform duration-300 ease-out [transform-box:fill-box] in-data-[popup-open]:[transform:rotateX(82deg)]"
        />
      </svg>
    </span>
  );
}
