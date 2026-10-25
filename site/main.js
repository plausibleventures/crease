// Small behaviours: the nav turns into a floating glass pill once you scroll, sections fade up as they arrive,
// and looping videos get a pause / play button (they stay still for people who asked for less motion).
(() => {
  "use strict"

  const nav = document.querySelector("[data-nav]")
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-floating", window.scrollY > 24)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
  }

  // Analytics (Google Analytics, set up in index.html): which links people follow and which demos they open.
  const track = (name, params) => { if (typeof window.gtag === "function") window.gtag("event", name, params) }
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]")
    if (!a) return
    if (/\.dmg$/.test(a.href)) track("download_app", { link_id: a.id || a.textContent.trim().slice(0, 40) })
    else if (/github\.com\/plausibleventures\/crease/.test(a.href)) track("view_source", { link_url: a.href })
  })

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const canObserve = "IntersectionObserver" in window

  // Looping videos.
  document.querySelectorAll("video[data-motion]").forEach((v) => {
    const btn = v.parentElement.querySelector("[data-toggle]")
    const sync = () => {
      if (!btn) return
      const playing = !v.paused
      btn.textContent = playing ? "Pause" : "Play"
      btn.toggleAttribute("data-playing", playing)
      btn.setAttribute("aria-label", `${playing ? "Pause" : "Play"} video`)
    }
    let userPaused = false
    const play = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}) }

    if (reduce) {
      v.removeAttribute("autoplay")
      v.pause()
    } else if (v.hasAttribute("data-inview") && canObserve) {
      // Plays while on screen, pauses when scrolled away.
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !userPaused) play()
        else if (!e.isIntersecting) v.pause()
      }, { threshold: 0.5 }).observe(v)
    } else if (v.hasAttribute("data-inview")) {
      play()
    }

    if (btn) {
      btn.hidden = false
      btn.addEventListener("click", () => {
        if (v.paused) { userPaused = false; play() } else { userPaused = true; v.pause() }
      })
      v.addEventListener("play", sync)
      v.addEventListener("pause", sync)
      sync()
    }
  })

  // Demos: one player; each tab swaps in its clip, poster and caption. Arrow keys move between tabs.
  const tabs = [...document.querySelectorAll(".demo-tabs [role=tab]")]
  const dv = document.querySelector("[data-demo-video]")
  if (tabs.length && dv) {
    const prompt = document.querySelector("[data-demo-prompt]")
    const designer = document.querySelector("[data-demo-designer]")
    const shows = document.querySelector("[data-demo-shows]")
    const pick = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab
        t.setAttribute("aria-selected", String(on))
        t.tabIndex = on ? 0 : -1
      })
      if (focus) { tab.focus(); tab.scrollIntoView({ block: "nearest", inline: "nearest" }) }
      const n = tab.dataset.demo
      track("view_demo", { demo: n })
      dv.poster = `assets/video/demos/${n}-poster.jpg`
      dv.src = `assets/video/demos/${n}.mp4`
      dv.setAttribute("aria-label", `${tab.textContent}: the designer at work in Crease`)
      prompt.textContent = `“${tab.dataset.prompt}”`
      designer.textContent = `Designed by ${tab.dataset.designer}`
      shows.textContent = tab.dataset.shows
      if (!reduce) { const p = dv.play(); if (p && p.catch) p.catch(() => {}) }
    }
    tabs.forEach((t, i) => {
      t.tabIndex = t.getAttribute("aria-selected") === "true" ? 0 : -1
      t.addEventListener("click", () => pick(t, false))
      t.addEventListener("keydown", (e) => {
        const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
        if (k) { e.preventDefault(); pick(tabs[(i + k + tabs.length) % tabs.length], true) }
        else if (e.key === "Home") { e.preventDefault(); pick(tabs[0], true) }
        else if (e.key === "End") { e.preventDefault(); pick(tabs[tabs.length - 1], true) }
      })
    })
  }

  const items = document.querySelectorAll(".reveal")
  if (reduce || !canObserve) {
    items.forEach((el) => el.classList.add("is-in"))
    return
  }
  // Stagger siblings that arrive together (a little, never more than 0.3 s).
  const io = new IntersectionObserver((entries) => {
    let i = 0
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.style.setProperty("--d", `${Math.min(i++ * 0.08, 0.3)}s`)
      e.target.classList.add("is-in")
      io.unobserve(e.target)
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 })
  items.forEach((el) => io.observe(el))
})()
