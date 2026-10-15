import { lazy, Suspense } from "react";
import Home from "./pages/Home.jsx";
const Streamer = lazy(() => import("./pages/Streamer.jsx"));
const Viewer = lazy(() => import("./pages/Viewer.jsx"));
const LiveHome = lazy(() => import("./pages/LiveHome.jsx"));
const LiveAnalytics = lazy(() => import("./pages/LiveAnalytics.jsx"));
const StreamDetails = lazy(() => import("./pages/StreamDetails.jsx"));
import {BrowserRouter as Router,Routes,Route} from "react-router-dom"
import VideoRoom from "./components/VideoRoom";
import Videos from "./pages/Videos.jsx";
import Login from "./pages/Login.jsx";
import AccountDashboard from "./pages/AccountDashboard.jsx";
import CreatorProfile from "./pages/CreatorProfile.jsx";
function App() {

  return (
    <Router>
      <Suspense fallback={<p role="status">Loading live stream...</p>}>
        <Routes>
          <Route path="/" element={<Home/>}/>
          <Route path="/login" element={<Login/>}/>
          <Route path="/account" element={<AccountDashboard/>}/>
          <Route path="/creators/:username" element={<CreatorProfile/>}/>
          <Route path="/videos" element={<Videos/>}/>
          <Route path="/live" element={<LiveHome/>}/>
          <Route path="/live/:roomId" element={<Viewer/>}/>
          <Route path="/live/:roomId/details" element={<StreamDetails/>}/>
          <Route path="/stream/:roomId" element={<StreamDetails/>}/>
          <Route path="/streamer/analytics/:roomId" element={<LiveAnalytics/>}/>
          <Route path="/call/:roomId" element={<VideoRoom/>}/>
          <Route path="/streamer" element={<Streamer/>}/>
          <Route path="/viewer" element={<Viewer/>}/>
          <Route path="/viewer/:roomId" element={<Viewer/>}/>
        </Routes>
      </Suspense>
    </Router>
  );

}

export default App;