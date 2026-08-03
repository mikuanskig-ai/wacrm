"use client";

import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface MediaLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  url: string;
  alt?: string;
}

/**
 * Full-viewport media viewer — WhatsApp-style "tap to open" behaviour.
 * Bypasses <DialogContent> (built for small centered form dialogs, see
 * ui/dialog.tsx) since a lightbox needs the whole screen and a dark
 * backdrop instead of the popover-card treatment.
 */
export function MediaLightbox({
  open,
  onOpenChange,
  kind,
  url,
  alt,
}: MediaLightboxProps) {
  // Click-to-zoom: a scale() transform on the image itself, container
  // stays centered the whole time — toggling layout/alignment classes
  // instead (what an earlier version did) made the image jump to a
  // corner on zoom, since removing its max-w/h let it blow past the
  // centered flex box. A transformed element still contributes to its
  // scrollable-overflow ancestor's scroll region per the CSS Transforms
  // spec, so `overflow-auto` here is enough to pan around when zoomed.
  // The parent only mounts this component while `lightbox` state is
  // set (see message-bubble.tsx) and unmounts it on close, so a fresh
  // mount always starts unzoomed — no reset-on-close effect needed.
  const [zoomed, setZoomed] = useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          onClick={() => onOpenChange(false)}
        >
          <DialogPrimitive.Close
            className="fixed top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
            aria-label="Close"
            onClick={(e) => e.stopPropagation()}
          >
            <XIcon className="h-5 w-5" />
          </DialogPrimitive.Close>

          {kind === "image" ? (
            <img
              src={url}
              alt={alt ?? ""}
              onClick={(e) => {
                e.stopPropagation();
                setZoomed((z) => !z);
              }}
              style={{ transform: zoomed ? "scale(2)" : "scale(1)" }}
              className={cn(
                "max-h-[85vh] max-w-[85vw] select-none rounded-sm object-contain transition-transform duration-150",
                zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
              )}
            />
          ) : (
            <video
              src={url}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] max-w-[85vw] rounded-sm"
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
