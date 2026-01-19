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
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const isPoliteRef = useRef(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasRemote, setHasRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [copied, setCopied] = useState(false);
  const [participants, setParticipants] = useState(1);

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

  // Create peer connection
  const createPeerConnection = (stream: MediaStream, ws: WebSocket) => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ]
    });
    pcRef.current = pc;

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.ontrack = (e) => {
      if (remoteVideoRef.current && e.streams[0]) {
        remoteVideoRef.current.srcObject = e.streams[0];
        setHasRemote(true);
        setParticipants(2);
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "ice-candidate",
          candidate: e.candidate,
          meetingId
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setHasRemote(false);
        setParticipants(1);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        ws.send(JSON.stringify({
          type: "offer",
          offer: pc.localDescription,
          meetingId
        }));
      } catch (err) {
        console.error("Negotiation error:", err);
      } finally {
        makingOfferRef.current = false;
      }
    };

    return pc;
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let ws: WebSocket | null = null;

    const init = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        ws = new WebSocket(`ws://${BACKEND_IP}:8000/conference`);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          createPeerConnection(stream!, ws!);
          ws!.send(JSON.stringify({ type: "join", meetingId }));
        };

        ws.onmessage = async (evt) => {
          const data = JSON.parse(evt.data);
          const pc = pcRef.current;
          if (!pc) return;

          try {
            if (data.type === "offer") {
              const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
              ignoreOfferRef.current = !isPoliteRef.current && offerCollision;
              
              if (ignoreOfferRef.current) return;

              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              await pc.setLocalDescription();
              ws!.send(JSON.stringify({
                type: "answer",
                answer: pc.localDescription,
                meetingId
              }));

            } else if (data.type === "answer") {
              if (pc.signalingState === "have-local-offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              }

            } else if (data.type === "ice-candidate" && data.candidate) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              } catch (e) {
                if (!ignoreOfferRef.current) {
                  console.warn("ICE error (can ignore):", e);
                }
              }

            } else if (data.type === "peer-joined") {
              isPoliteRef.current = true;
              setParticipants(p => p + 1);

            } else if (data.type === "peer-left") {
              setHasRemote(false);
              setParticipants(1);
              if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = null;
              }
            }
          } catch (err) {
            console.error("Message error:", err);
          }
        };

        ws.onclose = () => setConnected(false);
        ws.onerror = () => setError("Connection failed");

      } catch (err) {
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
            borderRadius: "20px",
            fontSize: "12px",
            background: connected ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)",
            color: connected ? "#22c55e" : "#ef4444"
          }}>
            ● {connected ? "Connected" : "Connecting..."}
          </span>
          <span style={{ color: "#888" }}>{formatTime(duration)}</span>
          <span style={{ color: "#888" }}>{participants}</span>
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
            <span style={{ padding: "2px 8px", background: "#a855f7", color: "#fff", borderRadius: "4px", fontSize: "12px" }}>HOST</span>
          </div>
          <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", borderRadius: "8px", background: "#1a1a2e", transform: "scaleX(-1)" }} />
        </div>

        <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: "12px", padding: "16px" }}>
          <span style={{ color: "#fff", marginBottom: "12px", display: "block" }}>{hasRemote ? "Remote" : "Waiting..."}</span>
          {hasRemote ? (
            <video ref={remoteVideoRef} autoPlay playsInline style={{ width: "100%", borderRadius: "8px", background: "#1a1a2e" }} />
          ) : (
            <div style={{ aspectRatio: "16/9", background: "#1a1a2e", borderRadius: "8px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "48px", height: "48px", border: "3px solid #333", borderTopColor: "#a855f7", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
              <span style={{ color: "#666" }}>Waiting for others</span>
              <span style={{ color: "#a855f7", fontFamily: "monospace" }}>{meetingId}</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: "12px" }}>
        <button onClick={toggleAudio} style={{ padding: "12px 24px", background: isAudioMuted ? "#ef4444" : "#333", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          {isAudioMuted ? "Unmute" : "Mute"}
        </button>
        <button onClick={toggleVideo} style={{ padding: "12px 24px", background: isVideoOff ? "#ef4444" : "#333", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          {isVideoOff ? "Start Video" : "Stop Video"}
        </button>
        <button onClick={copyMeetingId} style={{ padding: "12px 24px", background: "#a855f7", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          Invite
        </button>
        <button onClick={endCall} style={{ padding: "12px 24px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer" }}>
          End Call
        </button>
      </div>

      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
