// ============================================================
// NEON HARBOR — synthesized audio (Web Audio API, no files)
// SFX: engine hum, rain, sirens, horn, UI blips.
// MUSIC: procedural synthwave loop (bass/arp/pad/drums + echo).
// ============================================================

export class Synth {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private engOsc: OscillatorNode | null = null
  private engOscRef2: OscillatorNode | null = null
  private engGain: GainNode | null = null
  private sirenOsc: OscillatorNode | null = null
  private sirenGain: GainNode | null = null
  private sirenTimer: number | null = null
  private sirenHigh = false
  private rainGain: GainNode | null = null
  private rainLevel = 0
  private beachGain: GainNode | null = null
  private cityGain: GainNode | null = null
  muted = false

  // Music rig
  private musicGain: GainNode | null = null
  private musicFilter: BiquadFilterNode | null = null
  private musicDelay: DelayNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private musicTimer: number | null = null
  private nextNoteTime = 0
  private step = 0
  musicOn = false
  // Adaptive intensity 0..1 (police heat / boost): brightens the filter and
  // doubles the drum density so chases FEEL faster without changing the song
  private intensity = 0
  private intensityTarget = 0

  /** Must be called from a user gesture (click). */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 0.5
    this.master.connect(this.ctx.destination)

    // Engine hum: two detuned saws through a lowpass.
    this.engOsc = this.ctx.createOscillator()
    this.engOsc.type = 'sawtooth'
    const osc2 = this.ctx.createOscillator()
    osc2.type = 'sawtooth'
    osc2.detune.value = 12
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    this.engGain = this.ctx.createGain()
    this.engGain.gain.value = 0.0
    this.engOsc.connect(lp)
    osc2.connect(lp)
    lp.connect(this.engGain)
    this.engGain.connect(this.master)
    this.engOsc.frequency.value = 55
    osc2.frequency.value = 55
    this.engOsc.start()
    osc2.start()
    this.engOscRef2 = osc2

    // Siren
    this.sirenOsc = this.ctx.createOscillator()
    this.sirenOsc.type = 'triangle'
    this.sirenOsc.frequency.value = 700
    this.sirenGain = this.ctx.createGain()
    this.sirenGain.gain.value = 0
    this.sirenOsc.connect(this.sirenGain)
    this.sirenGain.connect(this.master)
    this.sirenOsc.start()

    // Rain noise
    const len = this.ctx.sampleRate * 2
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuf = buffer
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const rainLp = this.ctx.createBiquadFilter()
    rainLp.type = 'lowpass'
    rainLp.frequency.value = 520
    this.rainGain = this.ctx.createGain()
    this.rainGain.gain.value = 0
    src.connect(rainLp)
    rainLp.connect(this.rainGain)
    this.rainGain.connect(this.master)
    src.start()
    this.rainGain.gain.linearRampToValueAtTime(this.rainLevel * 0.045, this.ctx.currentTime + 1.5)

    // Ocean waves — filtered noise with a slow swell, gain driven by beach proximity
    const waveSrc = this.ctx.createBufferSource()
    waveSrc.buffer = buffer
    waveSrc.loop = true
    const waveBp = this.ctx.createBiquadFilter()
    waveBp.type = 'bandpass'
    waveBp.frequency.value = 420
    waveBp.Q.value = 0.6
    const waveLp = this.ctx.createBiquadFilter()
    waveLp.type = 'lowpass'
    waveLp.frequency.value = 900
    this.beachGain = this.ctx.createGain()
    this.beachGain.gain.value = 0
    waveSrc.connect(waveBp)
    waveBp.connect(waveLp)
    waveLp.connect(this.beachGain)
    this.beachGain.connect(this.master)
    waveSrc.start()

    // City hum — low traffic rumble downtown, fades as you leave the core
    const citySrc = this.ctx.createBufferSource()
    citySrc.buffer = buffer
    citySrc.loop = true
    const cityLp = this.ctx.createBiquadFilter()
    cityLp.type = 'lowpass'
    cityLp.frequency.value = 150
    this.cityGain = this.ctx.createGain()
    this.cityGain.gain.value = 0
    citySrc.connect(cityLp)
    cityLp.connect(this.cityGain)
    this.cityGain.connect(this.master)
    citySrc.start()

    this.startMusic()
  }

  /** Positional ambience: beach01 = closeness to the shore, city01 = downtown density. */
  updateAmbience(beach01: number, city01: number, time: number): void {
    if (!this.ctx || !this.beachGain || !this.cityGain) return
    // Hard guard: a non-finite input would throw inside setTargetAtTime and
    // kill the whole game loop — silence is always safer than a crash
    if (!Number.isFinite(beach01) || !Number.isFinite(city01) || !Number.isFinite(time)) return
    // slow rolling swell on the waves
    const swell = 0.7 + 0.3 * Math.sin(time * 0.55) * Math.sin(time * 0.23 + 1.7)
    this.beachGain.gain.setTargetAtTime(beach01 * 0.14 * swell, this.ctx.currentTime, 0.4)
    this.cityGain.gain.setTargetAtTime(city01 * 0.05, this.ctx.currentTime, 0.6)
  }

  // ---------------- MUSIC ----------------
  /** Synthwave loop: Am–F–C–G at 104 BPM. */
  startMusic(): void {
    if (!this.ctx || !this.master || this.musicGain) return
    this.musicGain = this.ctx.createGain()
    this.musicGain.gain.value = 0.14
    // Adaptive filter: mellow lowpass at rest, opens wide under pressure
    this.musicFilter = this.ctx.createBiquadFilter()
    this.musicFilter.type = 'lowpass'
    this.musicFilter.frequency.value = 1100
    this.musicFilter.Q.value = 0.6
    this.musicGain.connect(this.musicFilter)
    this.musicFilter.connect(this.master)
    // Echo for the arp
    const delay = this.ctx.createDelay(0.6)
    delay.delayTime.value = 0.29
    const fb = this.ctx.createGain()
    fb.gain.value = 0.34
    delay.connect(fb)
    fb.connect(delay)
    const wet = this.ctx.createGain()
    wet.gain.value = 0.3
    delay.connect(wet)
    wet.connect(this.musicGain)
    this.musicDelay = delay
    this.musicOn = true
    this.nextNoteTime = this.ctx.currentTime + 0.1
    this.step = 0
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 40)
  }

  private scheduleMusic(): void {
    if (!this.ctx || !this.musicOn) return
    // ease intensity toward its target — smooth musical build-up, no jumps
    this.intensity += (this.intensityTarget - this.intensity) * 0.12
    if (this.musicFilter) {
      this.musicFilter.frequency.setTargetAtTime(900 + this.intensity * 6800, this.ctx.currentTime, 0.25)
    }
    const eighth = 60 / 104 / 2
    while (this.nextNoteTime < this.ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextNoteTime)
      this.nextNoteTime += eighth
      this.step = (this.step + 1) % 32
    }
  }

  /** 0 = cruising mellow, 1 = full police chase. Called every frame. */
  setMusicIntensity(i: number): void {
    if (!Number.isFinite(i)) return
    this.intensityTarget = Math.min(Math.max(i, 0), 1)
  }

  private mNote(freq: number, t: number, dur: number, type: OscillatorType, vol: number, echo = false): void {
    if (!this.ctx || !this.musicGain) return
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g)
    g.connect(this.musicGain)
    if (echo && this.musicDelay) g.connect(this.musicDelay)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private mPad(freqs: number[], t: number, dur: number): void {
    freqs.forEach((f) => {
      this.mNote(f * 0.998, t, dur, 'sawtooth', 0.018)
      this.mNote(f * 1.003, t, dur, 'sawtooth', 0.018)
    })
  }

  private mDrum(kind: 'kick' | 'snare' | 'hat', t: number): void {
    if (!this.ctx || !this.musicGain || !this.noiseBuf) return
    if (kind === 'kick') {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(130, t)
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12)
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0.4, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      o.connect(g)
      g.connect(this.musicGain)
      o.start(t)
      o.stop(t + 0.2)
      return
    }
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuf
    const flt = this.ctx.createBiquadFilter()
    flt.type = 'highpass'
    flt.frequency.value = kind === 'hat' ? 7000 : 1800
    const g = this.ctx.createGain()
    const dur = kind === 'hat' ? 0.05 : 0.14
    g.gain.setValueAtTime(kind === 'hat' ? 0.07 : 0.16, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(flt)
    flt.connect(g)
    g.connect(this.musicGain)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / 8) // 0..3
    const chords = [
      [220.0, 261.63, 329.63], // Am
      [174.61, 220.0, 261.63], // F
      [261.63, 329.63, 392.0], // C
      [196.0, 246.94, 392.0],  // G
    ]
    const basses = [55.0, 43.65, 65.41, 49.0]
    const chord = chords[bar]
    const inBar = step % 8

    // Drums — density doubles when the heat is on
    const chase = this.intensity > 0.5
    if (step % 4 === 0 || (chase && inBar === 6)) this.mDrum('kick', t)
    if (inBar === 4 || (chase && inBar === 7)) this.mDrum('snare', t)
    if (chase || step % 2 === 0) this.mDrum('hat', t)
    // Pad at bar start
    if (inBar === 0) this.mPad(chord, t, 60 / 104 * 4)
    // Bass groove
    const bassPat = [0, 0, 12, 0, 0, 7, 0, 12]
    const semi = bassPat[inBar]
    this.mNote(basses[bar] * Math.pow(2, semi / 12), t, 0.22, 'sawtooth', 0.16 + this.intensity * 0.04)
    // Arp (echoed) — octave-jumps in a chase
    const arpNote = chord[step % 3] * 2 * (chase && inBar % 2 === 1 ? 2 : 1)
    this.mNote(arpNote, t, 0.14, 'square', 0.045 + this.intensity * 0.02, true)
  }

  // ---------------- SFX ----------------
  setMuted(m: boolean): void {
    this.muted = m
    if (this.master && this.ctx) {
      this.master.gain.linearRampToValueAtTime(m ? 0 : 0.5, this.ctx.currentTime + 0.1)
    }
  }

  /** Suspend the whole audio graph (host requested pause / tab hidden). */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend()
  }

  /** Resume the audio graph after a host pause / tab return. */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  updateEngine(speed01: number, boosting: boolean, dt: number): void {
    if (!this.ctx || !this.engOsc || !this.engGain) return
    const t = this.ctx.currentTime
    const target = 50 + speed01 * 160 + (boosting ? 40 : 0)
    this.engOsc.frequency.linearRampToValueAtTime(target, t + Math.max(dt, 0.016))
    if (this.engOscRef2) this.engOscRef2.frequency.linearRampToValueAtTime(target * 1.01, t + Math.max(dt, 0.016))
    const g = 0.045 + speed01 * 0.075
    this.engGain.gain.linearRampToValueAtTime(g, t + 0.05)
  }

  updateSiren(level: number, dt: number): void {
    if (!this.ctx || !this.sirenOsc || !this.sirenGain) return
    const t = this.ctx.currentTime
    this.sirenGain.gain.linearRampToValueAtTime(level * 0.05, t + 0.1)
    this.sirenTimer = (this.sirenTimer ?? 0) + dt
    if (this.sirenTimer > 0.42) {
      this.sirenTimer = 0
      this.sirenHigh = !this.sirenHigh
      this.sirenOsc.frequency.setTargetAtTime(this.sirenHigh ? 950 : 700, t, 0.03)
    }
  }

  setRain(level: number): void {
    this.rainLevel = level
    if (!this.ctx || !this.rainGain) return
    this.rainGain.gain.linearRampToValueAtTime(level * 0.045, this.ctx.currentTime + 1.2)
  }

  private blip(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo?: number): void {
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime + when
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g)
    g.connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  pickup(): void {
    this.blip(880, 0.12, 'sine', 0.22)
    this.blip(1320, 0.18, 'sine', 0.18, 0.07)
  }

  checkpoint(): void {
    this.blip(660, 0.1, 'square', 0.12)
    this.blip(990, 0.14, 'square', 0.1, 0.08)
  }

  buy(): void {
    this.blip(520, 0.1, 'triangle', 0.2)
    this.blip(780, 0.1, 'triangle', 0.2, 0.09)
    this.blip(1040, 0.2, 'triangle', 0.22, 0.18)
  }

  denied(): void {
    this.blip(220, 0.18, 'square', 0.14, 0, 160)
  }

  busted(): void {
    this.blip(440, 0.5, 'sawtooth', 0.25, 0, 90)
    this.blip(330, 0.6, 'square', 0.15, 0.1, 80)
  }

  missionDone(): void {
    ;[523, 659, 784, 1046].forEach((f, i) => this.blip(f, 0.22, 'triangle', 0.2, i * 0.1))
  }

  jump(): void {
    this.blip(300, 0.25, 'sine', 0.15, 0, 700)
  }

  thud(): void {
    this.blip(120, 0.15, 'sawtooth', 0.2, 0, 60)
  }

  horn(): void {
    this.blip(392, 0.2, 'square', 0.14)
    this.blip(494, 0.24, 'square', 0.14, 0.03)
  }

  chainUp(): void {
    this.blip(700, 0.08, 'square', 0.1)
    this.blip(1050, 0.12, 'square', 0.1, 0.05)
  }

  // Cash register "cha-ching" — reward feedback
  cash(): void {
    this.blip(1245, 0.09, 'triangle', 0.2)
    this.blip(1865, 0.22, 'triangle', 0.18, 0.07)
  }

  // Heavy impact: noise burst + low thump (crashes into poles/barriers)
  crash(): void {
    this.blip(95, 0.35, 'sawtooth', 0.3, 0, 38)
    this.blip(62, 0.4, 'square', 0.22, 0.02, 30)
    this.blip(1800, 0.12, 'sawtooth', 0.1, 0, 300)
  }

  // Car explosion: deep rolling boom + crackle on top (WRECKED game over)
  explosion(): void {
    this.blip(52, 0.9, 'sawtooth', 0.5, 0, 22)
    this.blip(38, 1.1, 'square', 0.4, 0.06, 18)
    this.blip(900, 0.5, 'sawtooth', 0.25, 0, 80)
    this.blip(2400, 0.18, 'square', 0.12, 0.02, 220)
    this.blip(140, 0.7, 'sawtooth', 0.3, 0.25, 30)
  }

  // Job accepted: rising confirm two-tone
  jobStart(): void {
    this.blip(523, 0.12, 'triangle', 0.2)
    this.blip(784, 0.2, 'triangle', 0.22, 0.1)
  }

  dispose(): void {
    try {
      if (this.musicTimer !== null) window.clearInterval(this.musicTimer)
      this.engOsc?.stop()
      this.engOscRef2?.stop()
      this.sirenOsc?.stop()
      void this.ctx?.close()
    } catch {
      // already closed
    }
    this.ctx = null
  }
}
