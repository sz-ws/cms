"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

// The pattern from src/ext/META.md ("A site supplies its own public pages"): the frame decides by the URL in a
// client component. Client components render on the server too, so the stored HTML already has the right frame.
// Same element types on every inner page = the header stays mounted when moving between them.
export function PathFrame({ notice, children }: { notice: ReactNode; children: ReactNode }) {
  const path = usePathname();
  if (path === "/")
    return (
      <div className="my-site" data-frame="home">
        {children}
        {notice}
      </div>
    );
  return (
    <div className="my-site" data-frame="inner">
      <header>Site header</header>
      {notice}
      {children}
      <footer>Site footer</footer>
    </div>
  );
}
