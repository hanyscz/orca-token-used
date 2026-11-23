import type { LiveAgentCard } from '../protocol'

export type MascotSpecies =
  | 'shiba'
  | 'cat'
  | 'penguin'
  | 'frog'
  | 'bunny'
  | 'bear'
  | 'fox'
  | 'duck'

export type MascotAccessory = 'none' | 'headband' | 'goggles' | 'leaf' | 'bow' | 'headphones'

export interface MascotPalette {
  id: string
  main: string
  dark: string
  light: string
  tint: string
}

export interface SessionMascot {
  species: MascotSpecies
  palette: MascotPalette
  accessory: MascotAccessory
  signature: string
}

export const MASCOT_SPECIES: readonly MascotSpecies[] = [
  'shiba',
  'cat',
  'penguin',
  'frog',
  'bunny',
  'bear',
  'fox',
  'duck'
]

export const MASCOT_PALETTES: readonly MascotPalette[] = [
  { id: 'amber', main: '#fbbf24', dark: '#d97706', light: '#fef3c7', tint: 'rgba(245, 158, 11, 0.16)' },
  { id: 'orange', main: '#fb923c', dark: '#ea580c', light: '#ffedd5', tint: 'rgba(249, 115, 22, 0.16)' },
  { id: 'mint', main: '#34d399', dark: '#059669', light: '#d1fae5', tint: 'rgba(16, 185, 129, 0.16)' },
  { id: 'sky', main: '#38bdf8', dark: '#0284c7', light: '#e0f2fe', tint: 'rgba(56, 189, 248, 0.16)' },
  { id: 'violet', main: '#c084fc', dark: '#9333ea', light: '#f3e8ff', tint: 'rgba(168, 85, 247, 0.16)' },
  { id: 'pink', main: '#f472b6', dark: '#db2777', light: '#fce7f3', tint: 'rgba(236, 72, 153, 0.16)' },
  { id: 'coral', main: '#fb7185', dark: '#e11d48', light: '#ffe4e6', tint: 'rgba(244, 63, 94, 0.16)' },
  { id: 'lime', main: '#a3e635', dark: '#65a30d', light: '#ecfccb', tint: 'rgba(132, 204, 22, 0.16)' }
]

export const MASCOT_ACCESSORIES: readonly MascotAccessory[] = [
  'none',
  'headband',
  'goggles',
  'leaf',
  'bow',
  'headphones'
]

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function escapeRaceHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Deterministically assigns a visually distinct cute mascot to each active
 * runtime session key:
 * - <= 8 concurrent sessions: unique species (never two of the same animal)
 * - 9..64 concurrent sessions: unique (species, palette)
 * - 65..384 concurrent sessions: unique (species, palette, accessory)
 */
export function assignSessionMascots(sessionKeys: string[]): Map<string, SessionMascot> {
  const uniqueSorted = Array.from(new Set(sessionKeys)).sort()
  const assigned = new Map<string, SessionMascot>()
  const usedSpecies = new Set<MascotSpecies>()
  const usedSpeciesPalette = new Set<string>()
  const usedFull = new Set<string>()

  const sLen = MASCOT_SPECIES.length
  const pLen = MASCOT_PALETTES.length
  const aLen = MASCOT_ACCESSORIES.length

  for (const key of uniqueSorted) {
    const h = hashString(key)
    const baseS = h % sLen
    const baseP = (h >>> 3) % pLen
    const baseA = (h >>> 6) % aLen

    let chosenSpecies = MASCOT_SPECIES[baseS]
    let chosenPalette = MASCOT_PALETTES[baseP]
    let chosenAccessory = MASCOT_ACCESSORIES[baseA]
    let placed = false

    // Tier 1: unique animal species
    if (usedSpecies.size < sLen) {
      for (let i = 0; i < sLen; i++) {
        const sp = MASCOT_SPECIES[(baseS + i) % sLen]
        if (!usedSpecies.has(sp)) {
          chosenSpecies = sp
          chosenPalette = MASCOT_PALETTES[(baseP + i) % pLen]
          chosenAccessory = MASCOT_ACCESSORIES[baseA]
          placed = true
          break
        }
      }
    }

    // Tier 2: unique (species, palette)
    if (!placed && usedSpeciesPalette.size < sLen * pLen) {
      outer2: for (let si = 0; si < sLen; si++) {
        const sp = MASCOT_SPECIES[(baseS + si) % sLen]
        for (let pi = 0; pi < pLen; pi++) {
          const pal = MASCOT_PALETTES[(baseP + pi) % pLen]
          const spKey = `${sp}:${pal.id}`
          if (!usedSpeciesPalette.has(spKey)) {
            chosenSpecies = sp
            chosenPalette = pal
            chosenAccessory = MASCOT_ACCESSORIES[(baseA + pi) % aLen]
            placed = true
            break outer2
          }
        }
      }
    }

    // Tier 3: unique (species, palette, accessory)
    if (!placed) {
      outer3: for (let ai = 0; ai < aLen; ai++) {
        const acc = MASCOT_ACCESSORIES[(baseA + ai) % aLen]
        for (let si = 0; si < sLen; si++) {
          const sp = MASCOT_SPECIES[(baseS + si) % sLen]
          for (let pi = 0; pi < pLen; pi++) {
            const pal = MASCOT_PALETTES[(baseP + pi) % pLen]
            const fullKey = `${sp}:${pal.id}:${acc}`
            if (!usedFull.has(fullKey)) {
              chosenSpecies = sp
              chosenPalette = pal
              chosenAccessory = acc
              placed = true
              break outer3
            }
          }
        }
      }
    }

    const signature = `${chosenSpecies}:${chosenPalette.id}:${chosenAccessory}`
    usedSpecies.add(chosenSpecies)
    usedSpeciesPalette.add(`${chosenSpecies}:${chosenPalette.id}`)
    usedFull.add(signature)
    assigned.set(key, {
      species: chosenSpecies,
      palette: chosenPalette,
      accessory: chosenAccessory,
      signature
    })
  }

  return assigned
}

function renderAccessorySvg(accessory: MascotAccessory, dark: string): string {
  switch (accessory) {
    case 'headband':
      return `<rect x="9.5" y="12.2" width="17" height="2.4" rx="1.2" fill="#ef4444"/><path d="M26 13.4L29.5 11.8L29.2 14.6Z" fill="#ef4444"/>`
    case 'goggles':
      return `<rect x="11.2" y="14.4" width="5.8" height="4.2" rx="2" fill="#e0f2fe" stroke="#0f172a" stroke-width="1.1"/><rect x="19" y="14.4" width="5.8" height="4.2" rx="2" fill="#e0f2fe" stroke="#0f172a" stroke-width="1.1"/><line x1="17" y1="16.5" x2="19" y2="16.5" stroke="#0f172a" stroke-width="1.2"/>`
    case 'leaf':
      return `<path d="M18 10.2C18 7 20.8 4.8 23.6 5.5C23.2 8.2 20.8 10.2 18 10.2Z" fill="#22c55e"/><line x1="18" y1="10.5" x2="17.5" y2="8.2" stroke="#15803d" stroke-width="1.2" stroke-linecap="round"/>`
    case 'bow':
      return `<path d="M18 10.8L14 8.5V13.1Z" fill="#f43f5e"/><path d="M18 10.8L22 8.5V13.1Z" fill="#f43f5e"/><circle cx="18" cy="10.8" r="1.4" fill="#ffe4e6"/>`
    case 'headphones':
      return `<path d="M8.5 19C8.5 12.2 12.6 8.2 18 8.2C23.4 8.2 27.5 12.2 27.5 19" stroke="${dark}" stroke-width="2" fill="none"/><rect x="6.5" y="17.2" width="3.2" height="5.6" rx="1.6" fill="#0f172a"/><rect x="26.3" y="17.2" width="3.2" height="5.6" rx="1.6" fill="#0f172a"/>`
    default:
      return ''
  }
}

export function renderMascotSvg(mascot: SessionMascot, className = 'tp-race-mascot'): string {
  const { main, dark, light } = mascot.palette
  let body = ''

  switch (mascot.species) {
    case 'shiba':
      body = `
        <path d="M10 14L8 7L15 10Z" fill="${dark}"/><path d="M26 14L28 7L21 10Z" fill="${dark}"/>
        <rect x="8.5" y="10" width="19" height="19" rx="9" fill="${main}"/>
        <ellipse cx="18" cy="22.5" rx="7" ry="5.2" fill="${light}"/>
        <circle cx="14.2" cy="17.5" r="1.6" fill="#1e293b"/><circle cx="21.8" cy="17.5" r="1.6" fill="#1e293b"/>
        <circle cx="14.7" cy="17" r="0.55" fill="#fff"/><circle cx="22.3" cy="17" r="0.55" fill="#fff"/>
        <ellipse cx="18" cy="20.4" rx="1.5" ry="1" fill="#1e293b"/>
        <path d="M16.5 22.4Q18 23.6 19.5 22.4" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'cat':
      body = `
        <path d="M10 14L8.5 7.2L15 10.4Z" fill="${dark}"/><path d="M26 14L27.5 7.2L21 10.4Z" fill="${dark}"/>
        <path d="M10.8 12.6L9.9 9.2L13.5 10.8Z" fill="${light}"/><path d="M25.2 12.6L26.1 9.2L22.5 10.8Z" fill="${light}"/>
        <rect x="8.5" y="10.5" width="19" height="18.5" rx="9" fill="${main}"/>
        <circle cx="14.5" cy="18" r="1.6" fill="#1e293b"/><circle cx="21.8" cy="18" r="1.6" fill="#1e293b"/>
        <circle cx="15" cy="17.4" r="0.55" fill="#fff"/><circle cx="22.3" cy="17.4" r="0.55" fill="#fff"/>
        <ellipse cx="11.6" cy="20.2" rx="1.5" ry="0.9" fill="#f43f5e" opacity="0.45"/>
        <ellipse cx="24.4" cy="20.2" rx="1.5" ry="0.9" fill="#f43f5e" opacity="0.45"/>
        <path d="M16.9 20.2Q18.1 21.6 19.3 20.2" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'penguin':
      body = `
        <rect x="9" y="9" width="18" height="20" rx="9" fill="${dark}"/>
        <ellipse cx="18" cy="21" rx="6.4" ry="7.2" fill="${light}"/>
        <circle cx="14.4" cy="15.8" r="1.5" fill="#0f172a"/><circle cx="21.6" cy="15.8" r="1.5" fill="#0f172a"/>
        <circle cx="14.9" cy="15.3" r="0.55" fill="#fff"/><circle cx="22.1" cy="15.3" r="0.55" fill="#fff"/>
        <path d="M16 18.2L18 20.4L20 18.2Z" fill="#fb923c"/>
        <ellipse cx="13.5" cy="29.5" rx="2.6" ry="1.4" fill="#fb923c"/><ellipse cx="22.5" cy="29.5" rx="2.6" ry="1.4" fill="#fb923c"/>`
      break
    case 'frog':
      body = `
        <circle cx="12.5" cy="11.5" r="4" fill="${main}"/><circle cx="23.5" cy="11.5" r="4" fill="${main}"/>
        <circle cx="12.5" cy="11.5" r="2.1" fill="#fff"/><circle cx="23.5" cy="11.5" r="2.1" fill="#fff"/>
        <circle cx="12.9" cy="11.5" r="1.15" fill="#0f172a"/><circle cx="23.9" cy="11.5" r="1.15" fill="#0f172a"/>
        <rect x="8.5" y="12.5" width="19" height="16.5" rx="8.2" fill="${main}"/>
        <ellipse cx="18" cy="23.2" rx="6" ry="4" fill="${light}"/>
        <path d="M15.2 19.2Q18 21.4 20.8 19.2" stroke="${dark}" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'bunny':
      body = `
        <rect x="11" y="4.5" width="4.2" height="10" rx="2.1" fill="${main}"/><rect x="20.8" y="4.5" width="4.2" height="10" rx="2.1" fill="${main}"/>
        <rect x="12.2" y="6.2" width="1.8" height="6.2" rx="0.9" fill="${light}"/><rect x="22" y="6.2" width="1.8" height="6.2" rx="0.9" fill="${light}"/>
        <rect x="9" y="12" width="18" height="17" rx="8.5" fill="${main}"/>
        <circle cx="14.5" cy="19.2" r="1.5" fill="#1e293b"/><circle cx="21.5" cy="19.2" r="1.5" fill="#1e293b"/>
        <circle cx="15" cy="18.7" r="0.5" fill="#fff"/><circle cx="22" cy="18.7" r="0.5" fill="#fff"/>
        <path d="M16.9 21.5Q18 22.6 19.1 21.5" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'bear':
      body = `
        <circle cx="11" cy="11.5" r="3.5" fill="${dark}"/><circle cx="25" cy="11.5" r="3.5" fill="${dark}"/>
        <circle cx="11" cy="11.5" r="1.6" fill="${light}"/><circle cx="25" cy="11.5" r="1.6" fill="${light}"/>
        <rect x="8.5" y="10.5" width="19" height="18.5" rx="9" fill="${main}"/>
        <ellipse cx="18" cy="21.5" rx="4.6" ry="3.4" fill="${light}"/>
        <circle cx="14.3" cy="17.8" r="1.5" fill="#1e293b"/><circle cx="21.7" cy="17.8" r="1.5" fill="#1e293b"/>
        <ellipse cx="18" cy="20.4" rx="1.4" ry="0.95" fill="#1e293b"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'fox':
      body = `
        <path d="M9.5 14L7.5 6.5L15.5 10.2Z" fill="${main}"/><path d="M26.5 14L28.5 6.5L20.5 10.2Z" fill="${main}"/>
        <path d="M9 9.5L8.2 7.2L11.2 8.6Z" fill="#1e293b"/><path d="M27 9.5L27.8 7.2L24.8 8.6Z" fill="#1e293b"/>
        <rect x="8.5" y="10.5" width="19" height="18.5" rx="9" fill="${main}"/>
        <path d="M9.5 21.5Q18 28.5 26.5 21.5Q26.5 29 18 29Q9.5 29 9.5 21.5Z" fill="${light}"/>
        <circle cx="14.3" cy="17.8" r="1.5" fill="#1e293b"/><circle cx="21.7" cy="17.8" r="1.5" fill="#1e293b"/>
        <ellipse cx="18" cy="21" rx="1.5" ry="1" fill="#1e293b"/>
        <circle cx="13.5" cy="29.3" r="2" fill="${dark}"/><circle cx="22.5" cy="29.3" r="2" fill="${dark}"/>`
      break
    case 'duck':
      body = `
        <path d="M16.5 9.2Q18 6 20 8.8" stroke="${dark}" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="8.5" y="10" width="19" height="19" rx="9" fill="${main}"/>
        <circle cx="14.4" cy="17.2" r="1.5" fill="#0f172a"/><circle cx="21.6" cy="17.2" r="1.5" fill="#0f172a"/>
        <circle cx="14.9" cy="16.7" r="0.5" fill="#fff"/><circle cx="22.1" cy="16.7" r="0.5" fill="#fff"/>
        <ellipse cx="18" cy="20.6" rx="3.5" ry="1.8" fill="#fb923c"/>
        <ellipse cx="13.5" cy="29.4" rx="2.5" ry="1.4" fill="#fb923c"/><ellipse cx="22.5" cy="29.4" rx="2.5" ry="1.4" fill="#fb923c"/>`
      break
  }

  const acc = renderAccessorySvg(mascot.accessory, dark)
  return `<svg class="${escapeRaceHtml(className)}" viewBox="0 0 36 36" fill="none" aria-hidden="true">${body}${acc}</svg>`
}

function truncateRaceLabel(title: string, maxLen = 18): string {
  const clean = title.trim()
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

export function renderSessionRaceTrackHtml(
  activeRacers: LiveAgentCard[],
  mascotByKey: Map<string, SessionMascot>,
  formatRate: (rate: number) => string
): string {
  if (activeRacers.length === 0) return ''

  const maxRate = Math.max(...activeRacers.map((r) => r.liveOutRate), 60)
  const workingRacers = activeRacers.filter((r) => r.state === 'working')
  const leader =
    workingRacers.length > 0
      ? [...workingRacers].sort((a, b) => b.liveOutRate - a.liveOutRate || b.tokens.total - a.tokens.total)[0]
      : null
  const anyMoving = activeRacers.some((r) => r.state === 'working' && r.liveOutRate > 0)

  const leaderHtml = leader
    ? `<span class="tp-race-leader" title="${escapeRaceHtml(leader.title)}">👑 ${escapeRaceHtml(truncateRaceLabel(leader.title, 16))} · ${escapeRaceHtml(formatRate(leader.liveOutRate))}</span>`
    : `<span class="tp-race-leader tp-race-leader-idle">${activeRacers.length} waiting</span>`

  const runnersHtml = activeRacers
    .map((racer, idx) => {
      const mascot = mascotByKey.get(racer.sessionKey)
      if (!mascot) return ''

      const isWorking = racer.state === 'working'
      const isSprinting = isWorking && racer.liveOutRate > 0
      const isLeader = Boolean(leader && leader.sessionKey === racer.sessionKey && leader.liveOutRate > 0)

      let pct: number
      if (isSprinting) {
        pct = Math.round(24 + Math.min(1, racer.liveOutRate / maxRate) * 62)
      } else if (isWorking) {
        pct = 20 + ((idx * 5) % 14)
      } else {
        pct = 9 + ((idx * 4) % 11)
      }
      const bottomPx = 4 + (idx % 2) * 3
      const stateCls = isSprinting
        ? 'tp-race-sprinting'
        : isWorking
          ? 'tp-race-thinking'
          : 'tp-race-waiting'
      const emote = isSprinting ? '' : isWorking ? '💭' : racer.state === 'blocked' ? '⚠️' : '✋'
      const tipText = `${truncateRaceLabel(racer.title, 20)} · ${isWorking ? formatRate(racer.liveOutRate) : racer.state}`

      const tipAlignCls = pct <= 18 ? ' tp-race-tip-left' : pct >= 82 ? ' tp-race-tip-right' : ''

      return `
        <div
          class="tp-race-runner ${stateCls}"
          role="button"
          tabindex="0"
          data-race-agent-key="${escapeRaceHtml(racer.sessionKey)}"
          aria-label="${escapeRaceHtml(tipText)}"
          style="left:${pct}%;bottom:${bottomPx}px"
        >
          ${isLeader ? '<span class="tp-race-crown" aria-hidden="true">👑</span>' : ''}
          ${emote ? `<span class="tp-race-emote" aria-hidden="true">${emote}</span>` : ''}
          <span class="tp-race-tip${tipAlignCls}">${escapeRaceHtml(tipText)}</span>
          ${renderMascotSvg(mascot, 'tp-race-mascot')}
        </div>
      `
    })
    .join('')

  return `
    <div class="tp-race-card">
      <div class="tp-race-top">
        <span class="tp-race-label">🏁 LIVE RACE · ${activeRacers.length}</span>
        ${leaderHtml}
      </div>
      <div class="tp-race-stage">
        <div class="tp-race-road${anyMoving ? '' : ' tp-race-road-paused'}"></div>
        <div class="tp-race-finish" aria-hidden="true"></div>
        ${runnersHtml}
      </div>
    </div>
  `
}
