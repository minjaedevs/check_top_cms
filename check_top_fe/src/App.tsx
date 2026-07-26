import { useWebSocket } from "./hooks/useWebSocket";
import { Header } from "./components/Header";
import { DeviceBoard } from "./components/DeviceBoard";
import { LogPanel } from "./components/LogPanel";

export default function App() {
  useWebSocket();

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <DeviceBoard />
        <LogPanel />
      </div>
    </div>
  );
}
