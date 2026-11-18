import type { Metadata, Viewport } from "next";
// Leaflet positions its panes/tiles absolutely; without its stylesheet the
// panes stack in normal flow and the map scatters down the page.
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeStride — night-time safe routing",
  description:
    "Dual pedestrian routing that weighs street lighting, open venues and local incidents.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#070B12",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
