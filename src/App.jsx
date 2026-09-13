import { Route, Routes } from 'react-router-dom';
import { ApiKeyProvider } from './context/ApiKeyContext.jsx';
import WelcomePage from './pages/WelcomePage.jsx';
import GeneratorPage from './pages/GeneratorPage.jsx';

export default function App() {
  return (
    <ApiKeyProvider>
      <Routes>
        <Route path="/" element={<WelcomePage />} />
        <Route path="/generator" element={<GeneratorPage />} />
      </Routes>
    </ApiKeyProvider>
  );
}
