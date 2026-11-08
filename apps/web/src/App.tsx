import { BoardPage } from './components/BoardPage';
import { HomePage } from './components/HomePage';
import { PwaBanner } from './components/PwaBanner';
import { useRoute } from './hooks/use-board';

function NotFound() {
  return (
    <main className="home">
      <h1>Not found</h1>
      <p>
        There is nothing at this address. <a href="/">Go to the start page</a>.
      </p>
    </main>
  );
}

function Page() {
  const route = useRoute();
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'board':
      return <BoardPage key={route.boardId} boardId={route.boardId} />;
    case 'not-found':
      return <NotFound />;
  }
}

/** Picks the page from the address: `/` is the start page and `/b/:boardId` a board. */
export function App() {
  return (
    <>
      <Page />
      <PwaBanner />
    </>
  );
}
