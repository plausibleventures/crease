import { describe, expect, it } from "vitest"
import type { NetworkInterfaceInfo } from "node:os"
import { DEFAULT_STUN, icePlan, isLanHost, normCameraIce } from "../../shared/camera-ice"
import { localAddressFor, rewriteMdnsCandidates } from "./camera"

// Shape of a Chromium recvonly offer with mDNS-hidden host candidates (non-trickle: candidates inline).
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "c=IN IP4 0.0.0.0",
  "a=candidate:2189246426 1 udp 2113937151 3c1e5f2a-8d4b-4f0e-9a51-2b7c0d9e1f33.local 52312 typ host generation 0 network-cost 999",
  "a=candidate:1024 1 udp 1677729535 203.0.113.7 52312 typ srflx raddr 0.0.0.0 rport 0 generation 0",
  "a=ice-ufrag:abcd",
  "a=recvonly",
  "",
].join("\r\n")

describe("mDNS candidate rewrite (local-only camera)", () => {
  it("replaces only mDNS host addresses, keeps everything else byte for byte", () => {
    const { sdp, rewritten } = rewriteMdnsCandidates(OFFER, "10.0.0.5")
    expect(rewritten).toBe(1)
    expect(sdp).toContain("a=candidate:2189246426 1 udp 2113937151 10.0.0.5 52312 typ host generation 0 network-cost 999")
    expect(sdp).toContain("203.0.113.7 52312 typ srflx")
    expect(sdp.split("\r\n").length).toBe(OFFER.split("\r\n").length)
    expect(sdp.replace("10.0.0.5", "3c1e5f2a-8d4b-4f0e-9a51-2b7c0d9e1f33.local")).toBe(OFFER)
  })
  it("rewrites an mDNS c= line and leaves offers without mDNS alone", () => {
    const withC = OFFER.replace("c=IN IP4 0.0.0.0", "c=IN IP4 3c1e5f2a-8d4b-4f0e-9a51-2b7c0d9e1f33.local")
    expect(rewriteMdnsCandidates(withC, "192.168.1.20").sdp).toContain("c=IN IP4 192.168.1.20\r\n")
    const plain = OFFER.replace("3c1e5f2a-8d4b-4f0e-9a51-2b7c0d9e1f33.local", "10.0.0.5")
    expect(rewriteMdnsCandidates(plain, "10.0.0.9")).toEqual({ sdp: plain, rewritten: 0 })
    expect(rewriteMdnsCandidates(OFFER, null)).toEqual({ sdp: OFFER, rewritten: 0 })
  })
  it("picks this computer's address on the printer's subnet", () => {
    const nic = (address: string, netmask: string, internal = false): NetworkInterfaceInfo =>
      ({ address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null }) as NetworkInterfaceInfo
    const ifaces = { lo0: [nic("127.0.0.1", "255.0.0.0", true)], utun3: [nic("100.64.1.2", "255.192.0.0")], en0: [nic("10.0.0.5", "255.255.255.0")] }
    expect(localAddressFor("10.0.0.24", ifaces)).toBe("10.0.0.5")
    expect(localAddressFor("192.168.7.7", ifaces)).toBe("100.64.1.2") // no match: first non-internal
    expect(localAddressFor("sparks.local", ifaces)).toBe("100.64.1.2")
    expect(localAddressFor("10.0.0.24", { lo0: ifaces.lo0 })).toBeNull()
  })
})

describe("camera ICE plan", () => {
  it("knows LAN hosts", () => {
    for (const h of ["10.0.0.24", "192.168.1.50", "172.20.0.3", "169.254.1.1", "sparks.local", "printer", "fd12:3456::1"]) expect(isLanHost(h), h).toBe(true)
    for (const h of ["8.8.8.8", "172.32.0.1", "printer.example.com", ""]) expect(isLanHost(h), h).toBe(false)
  })
  it("defaults to no STUN for LAN printers, with one STUN retry", () => {
    const p = icePlan({ type: "moonraker", host: "10.0.0.24" })
    expect(p.first).toEqual([])
    expect(p.fallback).toEqual([{ urls: DEFAULT_STUN }])
  })
  it("local mode never uses STUN; custom always uses its list", () => {
    expect(icePlan({ type: "moonraker", host: "10.0.0.24", cameraIce: { mode: "local" } })).toMatchObject({ first: [], fallback: null })
    const c = icePlan({ type: "moonraker", host: "10.0.0.24", cameraIce: { mode: "custom", stunServers: ["stun:stun.example.org:3478"] } })
    expect(c).toMatchObject({ first: [{ urls: ["stun:stun.example.org:3478"] }], fallback: null })
    // auto with a custom fallback list
    expect(icePlan({ type: "moonraker", host: "10.0.0.24", cameraIce: { mode: "auto", stunServers: ["stun:lan-stun:3478"] } }).fallback).toEqual([{ urls: ["stun:lan-stun:3478"] }])
  })
  it("non-LAN printers keep STUN", () => {
    expect(icePlan({ type: "moonraker", host: "printer.example.com" }).first).toEqual([{ urls: DEFAULT_STUN }])
  })
  it("cleans settings", () => {
    expect(normCameraIce(undefined)).toBeNull()
    expect(normCameraIce({ mode: "auto" })).toBeNull()
    expect(normCameraIce({ mode: "local" })).toEqual({ mode: "local" })
    expect(normCameraIce({ mode: "custom", stunServers: ["stun:a:1", "http://bad", " stun:b:2 "] })).toEqual({ mode: "custom", stunServers: ["stun:a:1", "stun:b:2"] })
    expect(normCameraIce({ mode: "weird" })).toBeNull()
  })
})
