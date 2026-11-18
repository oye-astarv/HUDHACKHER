import TrackClient from "./TrackClient";

export const metadata = {
  title: "SafeStride — live tracking",
  robots: { index: false, follow: false },
};

/** One static page; the session id is read from /track/{id} in the browser. */
export default function Page() {
  return <TrackClient />;
}
