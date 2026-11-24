import { ThemeProvider } from './hooks/useTheme';
import { AppShell } from './shell/AppShell';

// The older TapeFlow layout (DashboardLayout) stays in the repo until every panel is restyled.
// ThemeProvider is still needed by the reused TapeFlow panels.
function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

export default App;
