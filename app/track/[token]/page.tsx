import TrackClient from "./TrackClient";

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TrackClient token={token} />;
}
