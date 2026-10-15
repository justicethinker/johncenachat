import { Room } from "./Room";
import { Home } from "./Home";
import { QuickStart } from "./QuickStart";
import { useRoute } from "./router";

export function App() {
  const route = useRoute();

  if (route.kind === "room") {
    return <Room key={route.roomId} roomId={route.roomId} />;
  }
  if (route.kind === "home") {
    return <Home />;
  }
  if (route.kind === "quickStart") {
    return <QuickStart key={window.location.pathname} requested={route.count} />;
  }
  return (
    <main className="page">
      <div className="home">
        <h1 className="title">Aside</h1>
        <p className="tagline">This link does not exist.</p>
      </div>
    </main>
  );
}
