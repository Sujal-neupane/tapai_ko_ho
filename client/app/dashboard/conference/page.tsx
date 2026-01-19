"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Backend IP - Change this to host's IP
const BACKEND_IP = '172.20.10.13';

export default function ConferencePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const meetingId = searchParams.get("meetingId") || "MEETING";

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isPoliteRef = useRef(false); // true = we yield on collision, false = we win
  const localStreamRef = useRef<MediaStream | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasRemote, setHasRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [copied, setCopied] = useState(false);
  const [participants, setParticipants] = useState(1);
  const [isHost, setIsHost] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m.toString().padStart(2, "0") + ":" + sec.toString().padStart(2, "0");
  };

  const copyMeetingId = () => {
    navigator.clipboard.writeText(meetingId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Create a fresh peer connection
  const createPeerConnection = () => {
    // Close existing connection if any
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        // Free TURN servers for NAT traversal
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:openrelay.metered.ca:443?transport=tcp",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ],
      iceCandidatePoolSize: 10
    });

    pcRef.current = pc;

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    // Handle incoming tracks
    pc.ontrack = (e) => {
      console.log("Got remote track:", e.track.kind);
      if (remoteVideoRef.current && e.streams[0]) {
        remoteVideoRef.current.srcObject = e.streams[0];
        setHasRemote(true);
        setParticipants(2);
      }
    };

    // Send ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: "ice-candidate",
          candidate: e.candidate,
          meetingId
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") {
        console.log("ICE failed, restarting...");
        pc.restartIce();
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        setHasRemote(true);
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setHasRemote(false);
        setParticipants(1);
      }
    };

    return pc;
  };

  // Send an offer (only called by impolite peer)
  const sendOffer = async () => {
    const pc = pcRef.current;
    const ws = wsRef.current;
    if (!pc || !ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      console.log("Creating offer...");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({
        type: "offer",
        offer: pc.localDescription,
        meetingId
      }));
      console.log("Offer sent");
    } catch (err) {
      console.error("Error sending offer:", err);
    }
  };

  useEffect(() => {
    let stream: MediaStream | null = null;

    const init = async () => {
      try {
        // Get camera/mic
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: true, 
          video: { width: 640, height: 480 } 
        });
        localStreamRef.current = stream;
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Connect to signaling server
        const ws = new WebSocket(`ws://${BACKEND_IP}:8000/conference`);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("WebSocket connected");
          setConnected(true);
          // Create peer connection (but don't send offer yet)
          createPeerConnection();
          // Join the room
          ws.send(JSON.stringify({ type: "join", meetingId }));
        };

        ws.onmessage = async (evt) => {
          const data = JSON.parse(evt.data);
          const pc = pcRef.current;
          
          console.log("Received:", data.type);

          if (data.type === "joined") {
            // Server confirms we joined
            const existingPeers = data.existingPeers || [];
            console.log("Joined room, existing peers:", existingPeers.length);
            
            if (existingPeers.length > 0) {
              // We are the polite peer (new joiner)
              isPoliteRef.current = true;
              setIsHost(false);
              setParticipants(existingPeers.length + 1);
              console.log("We are POLITE (new joiner)");
            } else {
              // We are the impolite peer (first in room)
              isPoliteRef.current = false;
              setIsHost(true);
              console.log("We are IMPOLITE (first in room)");
            }
          }

          else if (data.type === "peer-joined") {
            // A new peer joined - we are the existing peer (impolite)
            console.log("New peer joined, we send offer");
            setParticipants(p => p + 1);
            
            // Send offer with current peer connection
            const currentPc = pcRef.current;
            const currentWs = wsRef.current;
            if (currentPc && currentWs && currentWs.readyState === WebSocket.OPEN) {
              try {
                console.log("Creating offer for new peer...");
                const offer = await currentPc.createOffer();
                await currentPc.setLocalDescription(offer);
                currentWs.send(JSON.stringify({
                  type: "offer",
                  offer: currentPc.localDescription,
                  meetingId
                }));
                console.log("Offer sent to new peer");
              } catch (err) {
                console.error("Error sending offer:", err);
              }
            }
          }

          else if (data.type === "offer") {
            if (!pc) return;
            console.log("Received offer, signalingState:", pc.signalingState);
            
            try {
              // If we're not polite and we have a pending offer, ignore incoming
              if (!isPoliteRef.current && pc.signalingState !== "stable") {
                console.log("Ignoring offer (we are impolite and not stable)");
                return;
              }
              
              // If we need to rollback our own offer
              if (pc.signalingState !== "stable") {
                console.log("Rolling back local description");
                await pc.setLocalDescription({ type: "rollback" });
              }
              
              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              
              wsRef.current?.send(JSON.stringify({
                type: "answer",
                answer: pc.localDescription,
                meetingId
              }));
              console.log("Answer sent");
            } catch (err) {
              console.error("Error handling offer:", err);
            }
          }

          else if (data.type === "answer") {
            if (!pc) return;
            console.log("Received answer, signalingState:", pc.signalingState);
            
            try {
              if (pc.signalingState === "have-local-offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log("Answer applied");
              } else {
                console.log("Ignoring answer, wrong state:", pc.signalingState);
              }
            } catch (err) {
              console.error("Error handling answer:", err);
            }
          }

          else if (data.type === "ice-candidate" && data.candidate) {
            if (!pc) return;
            try {
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              }
            } catch (err) {
              // Ignore ICE errors
            }
          }

          else if (data.type === "peer-left") {
            console.log("Peer left");
            setHasRemote(false);
            setParticipants(1);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = null;
            }
            // Reset for next peer
            createPeerConnection();
          }
        };

        ws.onclose = () => {
          console.log("WebSocket closed");
          setConnected(false);
        };

        ws.onerror = (e) => {
          console.error("WebSocket error:", e);
          setError("Connection failed");
        };

      } catch (err) {
        console.error("Init error:", err);
        setError("Camera/Mic access denied. Please allow permissions.");
      }
    };

    init();

    return () => {
      stream?.getTracks().forEach(t => t.stop());
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, [meetingId]);

  const toggleAudio = () => {
    localStream?.getAudioTracks().forEach(t => t.enabled = !t.enabled);
    setIsAudioMuted(!isAudioMuted);
  };

  const toggleVideo = () => {
    localStream?.getVideoTracks().forEach(t => t.enabled = !t.enabled);
    setIsVideoOff(!isVideoOff);
  };

  const endCall = () => {
    localStream?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
    wsRef.current?.close();
    router.push("/dashboard");
  };

  return (
    <div style={{ padding: "24px", minHeight: "100vh", background: "#0a0a0f" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <h1 style={{ fontSize: "24px", fontWeight: "bold", color: "#fff" }}>Video Conference</h1>
          <span style={{
            padding: "4px 12px",
            borderRadius: "999px",
            fontSize: "12px",
            background: connected ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
            color: connected ? "#22c55e" : "#ef4444",
          }}>
            {connected ? "● Connected" : "● Disconnected"}
          </span>
          <span style={{ color: "#888" }}>{formatTime(duration)}</span>
          <span style={{ color: "#888" }}>👥 {participants}</span>
        </div>
        <button onClick={endCall} style={{ padding: "8px 16px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          End Call
        </button>
      </div>

      <div style={{ padding: "16px", marginBottom: "16px", background: "rgba(255,255,255,0.05)", borderRadius: "12px", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px" }}>
        <span style={{ color: "#888" }}>Share this ID:</span>
        <span style={{ color: "#a855f7", fontWeight: "bold", fontFamily: "monospace" }}>{meetingId}</span>
        <button onClick={copyMeetingId} style={{ padding: "6px 12px", background: "#333", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer" }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {error && (
        <div style={{ padding: "12px", marginBottom: "16px", background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "8px", color: "#ef4444" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: hasRemote ? "1fr 1fr" : "1fr", gap: "16px", marginBottom: "24px" }}>
        <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ color: "#fff" }}>You</span>
            <span style={{ padding: "2px 8px", background: isHost ? "#a855f7" : "#22c55e", color: "#fff", borderRadius: "4px", fontSize: "12px" }}>{isHost ? "HOST" : "GUEST"}</span>
          </div>
          <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", borderRadius: "8px", background: "#1a1a2e", transform: "scaleX(-1)" }} />
        </div>

        {hasRemote ? (
          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "12px", padding: "16px" }}>
            <span style={{ color: "#fff", marginBottom: "12px", display: "block" }}>Remote</span>
            <video ref={remoteVideoRef} autoPlay playsInline style={{ width: "100%", borderRadius: "8px", background: "#1a1a2e" }} />
          </div>
        ) : (
          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "12px", padding: "16px" }}>
            <span style={{ color: "#fff", marginBottom: "12px", display: "block" }}>Waiting for peer...</span>
            <div style={{ aspectRatio: "16/9", background: "#1a1a2e", borderRadius: "8px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "48px", height: "48px", border: "3px solid #333", borderTopColor: "#a855f7", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
              <span style={{ color: "#666" }}>Waiting for others to join</span>
              <span style={{ color: "#a855f7", fontFamily: "monospace" }}>{meetingId}</span>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: "12px" }}>
        <button onClick={toggleAudio} style={{ padding: "12px 24px", background: isAudioMuted ? "#ef4444" : "#333", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          {isAudioMuted ? "🔇 Unmute" : "🎤 Mute"}
        </button>
        <button onClick={toggleVideo} style={{ padding: "12px 24px", background: isVideoOff ? "#ef4444" : "#333", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          {isVideoOff ? "📷 Start Video" : "🎥 Stop Video"}
        </button>
        <button onClick={copyMeetingId} style={{ padding: "12px 24px", background: "#a855f7", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          📋 Share Meeting ID
        </button>
        <button onClick={endCall} style={{ padding: "12px 24px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          📞 End Call
        </button>
      </div>

      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
