import { Home } from "./Home";
import { Room } from "./Room";
import { useRoute } from "./router";

export function App() {
  const route = useRoute();

  if (route.kind === "room") {
    return <Room key={route.roomId} />;
  }
  if (route.kind === "home") {
    return <Home />;
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
