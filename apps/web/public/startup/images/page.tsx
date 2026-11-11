import NeuromorphicCanvas from "@/components/NeuromorphicCanvas";
import ChatOverlay from "@/components/ChatOverlay";

export default function Home() {
  return (
    <main className="relative w-full h-screen overflow-hidden bg-black font-sans">
      <NeuromorphicCanvas />
      <ChatOverlay />
    </main>
  );
}
