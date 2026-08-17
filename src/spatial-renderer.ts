import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { semanticXAtSeq } from './station-layout';
import type { EntityKind, SpatialEntity, SpatialRelation, SpatialSceneState } from './types';

type Theme = 'dark' | 'light';
type Language = 'zh' | 'en';

type Palette = {
  background: number;
  fog: number;
  grid: number;
  axis: number;
  label: string;
  labelInk: string;
  agent: number;
  subagent: number;
  file: number;
  tool: number;
  external: number;
  event: number;
  unknown: number;
  read: number;
  write: number;
  'tool-call': number;
  delegate: number;
  flow: number;
};

const palettes: Record<Theme, Palette> = {
  dark: {
    background: 0x0d1522,
    fog: 0x0d1522,
    grid: 0x26364b,
    axis: 0x54708e,
    label: 'rgba(12, 21, 34, .78)',
    labelInk: '#e0eafa',
    agent: 0x8ba8ff,
    subagent: 0x64cfb0,
    file: 0xc2b1f7,
    tool: 0xf1bb75,
    external: 0xdc90b2,
    event: 0x9fb4ff,
    unknown: 0x8295ae,
    read: 0x89b4ff,
    write: 0xf1bb75,
    'tool-call': 0xc4a5f2,
    delegate: 0x68d4b7,
    flow: 0x8ba8ff,
  },
  light: {
    background: 0xf2f0eb,
    fog: 0xf2f0eb,
    grid: 0xcdd0d2,
    axis: 0x7b8997,
    label: 'rgba(250, 249, 246, .84)',
    labelInk: '#263548',
    agent: 0x4e68bd,
    subagent: 0x278c76,
    file: 0x8466b4,
    tool: 0xb2752a,
    external: 0xa55278,
    event: 0x5d72b8,
    unknown: 0x67798d,
    read: 0x5378b7,
    write: 0xb2752a,
    'tool-call': 0x8663b9,
    delegate: 0x258e78,
    flow: 0x4e68bd,
  },
};

const labels: Record<Language, Record<EntityKind, string>> = {
  zh: { agent: '主 Agent', subagent: '子 Agent', file: '文件', tool: '工具', external: '外部资源', event: '轨迹事件', unknown: '事件' },
  en: { agent: 'Main Agent', subagent: 'Subagent', file: 'File', tool: 'Tool', external: 'External', event: 'Trajectory event', unknown: 'Event' },
};

export interface RendererOptions {
  reducedMotion?: boolean;
  theme?: Theme;
  language?: Language;
  onSelect?: (entityId?: string, anchor?: { x: number; y: number }) => void;
}

type PulseObject = { mesh: THREE.Mesh; relation: SpatialRelation; phase: number; startedAt: number; duration: number };
type MessageCard = { sprite: THREE.Sprite; group: THREE.Group; priority: number; role: 'user' | 'assistant' };
type FocusTarget = { target: THREE.Vector3; position: THREE.Vector3 };
type InteractionTether = {
  line: THREE.Line;
  particles: THREE.Mesh[];
  sourceId: string;
  targetId: string;
  kind: SpatialRelation['kind'];
  style: 'response' | 'primary-work' | 'companion-work';
  phase: number;
  burstStartedAt: number;
  burstDuration: number;
};
type DisposableObject = THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };

function shortLabel(value: string): string {
  return value.length > 28 ? `${value.slice(0, 27)}…` : value;
}

function fileLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

/** The canvas bubble is intentionally compact; strip Markdown syntax there while
 * the selectable inspector renders the full rich document. */
function messagePreviewText(value: string): string {
  return value
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\n)>\s?/g, '$1')
    .trim();
}

function disposeMaterial(material: THREE.Material): void {
  const withMaps = material as THREE.Material & Record<string, unknown>;
  for (const value of Object.values(withMaps)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

function multiplyObjectOpacity(object: THREE.Object3D, factor: number): void {
  object.traverse((child) => {
    const material = (child as DisposableObject).material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const item of materials) {
      item.transparent = true;
      item.opacity *= factor;
      if (factor < 0.95) item.depthWrite = false;
    }
  });
}

export class SpatialRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 600);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly root = new THREE.Group();
  private readonly environmentLayer = new THREE.Group();
  private readonly guideLayer = new THREE.Group();
  private readonly stationLayer = new THREE.Group();
  private readonly workLayer = new THREE.Group();
  private readonly relationLayer = new THREE.Group();
  private readonly pulseLayer = new THREE.Group();
  private readonly nodeLayer = new THREE.Group();
  private readonly selectionLayer = new THREE.Group();
  private readonly resizeObserver: ResizeObserver;
  private readonly onSelect?: RendererOptions['onSelect'];
  private reducedMotion = false;
  private theme: Theme = 'dark';
  private language: Language = 'zh';
  private frame = 0;
  private resizeFrame = 0;
  private state?: SpatialSceneState;
  private selectedId?: string;
  private focusTarget?: FocusTarget;
  private pointerDown?: { x: number; y: number };
  private nodeObjects = new Map<string, THREE.Group>();
  private nodeKinds = new Map<string, EntityKind>();
  /** Last rendered locations survive a state rebuild so streamed events travel
   * into place instead of visually teleporting through the workbench. */
  private motionPositions = new Map<string, THREE.Vector3>();
  private pulseObjects: PulseObject[] = [];
  private interactionTethers: InteractionTether[] = [];
  private readonly workbenchCenter = new THREE.Vector3();
  private workbenchPulse?: THREE.Mesh;
  private workbenchCore?: THREE.Mesh;
  private messageCards: MessageCard[] = [];
  private lastTime = performance.now();
  private initialFramed = false;
  private latestCursorCoordinate?: number;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.onSelect = options.onSelect;
    this.reducedMotion = options.reducedMotion ?? false;
    this.theme = options.theme ?? 'dark';
    this.language = options.language ?? 'zh';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    // The spatial view is embedded in a constrained conversation pane. A 1.35x
    // ceiling keeps text readable while materially reducing the color/depth
    // buffers on Retina displays (the previous 1.75x setting consumed ~68% more
    // pixels at the cap).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.theme === 'dark' ? 1.08 : 1.02;
    // Start near the live tail instead of centering the full historical range.
    // Long Harness sessions otherwise leave the current Agent pressed against
    // the right edge on the first frame.
    this.camera.position.set(18, 10.5, 24);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 90;
    this.controls.target.set(0, 0.6, 0);
    this.scene.add(this.root);
    this.root.add(this.environmentLayer, this.guideLayer, this.stationLayer, this.workLayer, this.relationLayer, this.pulseLayer, this.nodeLayer, this.selectionLayer);
    this.applyTheme();
    this.buildEnvironment();
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.resize());
    });
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  private get palette(): Palette { return palettes[this.theme]; }

  private applyTheme(): void {
    const palette = this.palette;
    this.renderer.setClearColor(palette.background, 1);
    this.scene.background = new THREE.Color(palette.background);
    this.scene.fog = new THREE.FogExp2(palette.fog, this.theme === 'dark' ? 0.012 : 0.009);
    this.renderer.toneMappingExposure = this.theme === 'dark' ? 1.08 : 1.02;
  }

  private buildEnvironment(): void {
    this.clearLayer(this.environmentLayer);
    const palette = this.palette;
    const ambient = new THREE.HemisphereLight(this.theme === 'dark' ? 0xc4d4ee : 0xfbf8ef, this.theme === 'dark' ? 0x172131 : 0xbfc5c9, 1.65);
    const key = new THREE.DirectionalLight(this.theme === 'dark' ? 0xe2eaff : 0xffffff, this.theme === 'dark' ? 2.05 : 1.55);
    key.position.set(7, 15, 13);
    const rim = new THREE.PointLight(palette.agent, this.theme === 'dark' ? 17 : 7, 46, 2);
    rim.position.set(-18, 6, 15);
    const counter = new THREE.PointLight(palette.delegate, this.theme === 'dark' ? 8 : 3.5, 32, 2);
    counter.position.set(15, 2, -15);
    this.environmentLayer.add(ambient, key, rim, counter);

    // Sparse depth cues are sufficient here; a dense star field adds draw work
    // without conveying trajectory state.
    const starCount = 64;
    const positions = new Float32Array(starCount * 3);
    for (let index = 0; index < starCount; index += 1) {
      const seed = Math.sin(index * 91.173) * 10000;
      positions[index * 3] = ((seed - Math.floor(seed)) - 0.5) * 72;
      positions[index * 3 + 1] = 1 + ((Math.sin(seed * 2.3) + 1) * 0.5) * 27;
      positions[index * 3 + 2] = ((Math.cos(seed * 1.7) + 1) * 0.5 - 0.5) * 56;
    }
    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.environmentLayer.add(new THREE.Points(stars, new THREE.PointsMaterial({
      color: this.theme === 'dark' ? 0xa8bbd3 : 0x8090a0,
      size: this.theme === 'dark' ? 0.075 : 0.052,
      transparent: true,
      opacity: this.theme === 'dark' ? 0.38 : 0.26,
      depthWrite: false,
    })));
  }

  private colorForEntity(entity: SpatialEntity): number {
    if (entity.eventRole === 'agent-start') return this.palette.delegate;
    if (entity.eventRole === 'agent-end') return entity.state === 'error' ? 0xdf667c : this.palette.write;
    if (entity.eventRole === 'user-message') return this.palette.external;
    if (entity.eventRole === 'assistant-message') return this.palette.agent;
    return this.palette[entity.kind];
  }

  private labelForEntity(entity: SpatialEntity): string {
    if (entity.eventRole === 'agent-start') return this.language === 'zh' ? 'Agent 开始' : 'Agent started';
    if (entity.eventRole === 'agent-end') return this.language === 'zh' ? 'Agent 结束' : 'Agent completed';
    if (entity.eventRole === 'user-message') return this.language === 'zh' ? '用户消息' : 'User message';
    if (entity.eventRole === 'assistant-message') return this.language === 'zh' ? 'Agent 回复' : 'Agent response';
    if (entity.kind === 'file') return fileLabel(entity.path ?? entity.label);
    return entity.label;
  }

  private bubbleLines(context: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number): { lines: string[]; truncated: boolean } {
    const normalized = Array.from(value.replace(/\s+/g, ' ').trim());
    const lines: string[] = [];
    let line = '';
    let consumed = 0;
    for (const character of normalized) {
      const candidate = `${line}${character}`;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
        if (lines.length === maxLines) break;
      } else {
        line = candidate;
      }
      consumed += 1;
    }
    if (lines.length < maxLines && line) lines.push(line);
    const truncated = consumed < normalized.length;
    if (truncated && lines.length) lines[lines.length - 1] = `${lines.at(-1)!.replace(/[.…]+$/, '')}…`;
    return { lines, truncated };
  }

  private createMessageBubble(entity: SpatialEntity): THREE.Sprite {
    const full = entity.metadata.messageLod === 'full';
    const canvas = document.createElement('canvas');
    // Canvas textures are the dominant per-message GPU allocation. Drawing at
    // 75% of the old resolution is visually indistinguishable at this panel size
    // but reduces each texture's pixel storage by roughly 44%.
    const canvasScale = 0.75;
    canvas.width = 768;
    canvas.height = full ? 375 : 219;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Sprite();
    context.scale(canvasScale, canvasScale);
    const user = entity.eventRole === 'user-message';
    const accentCss = `#${new THREE.Color(this.colorForEntity(entity)).getHexString()}`;
    context.fillStyle = this.theme === 'dark' ? 'rgba(14, 24, 38, .76)' : 'rgba(252, 251, 247, .82)';
    context.beginPath();
    const bodyBottom = full ? 430 : 246;
    context.roundRect(24, 20, 976, bodyBottom - 20, 34);
    context.fill();
    context.beginPath();
    context.moveTo(user ? 120 : 855, bodyBottom - 2);
    context.lineTo(user ? 170 : 905, bodyBottom - 2);
    context.lineTo(user ? 145 : 885, bodyBottom + 44);
    context.closePath();
    context.fill();
    context.strokeStyle = this.theme === 'dark' ? 'rgba(208, 222, 244, .22)' : 'rgba(43, 58, 76, .20)';
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(24, 20, 976, bodyBottom - 20, 34);
    context.stroke();
    context.fillStyle = accentCss;
    context.font = '700 29px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    const assistantHeading = entity.state === 'running'
      ? (this.language === 'zh' ? 'Agent · 正在回复' : 'Agent · replying')
      : (this.language === 'zh' ? 'Agent 回复' : 'Agent response');
    context.fillText(user ? (this.language === 'zh' ? '你' : 'You') : assistantHeading, 60, 72);
    context.fillStyle = this.palette.labelInk;
    context.font = '500 34px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    const message = messagePreviewText(entity.message?.trim() || (this.language === 'zh' ? '正在生成回复…' : 'Generating response…'));
    const wrapped = this.bubbleLines(context, message, 895, full ? 4 : 2);
    wrapped.lines.forEach((line, index) => context.fillText(line, 60, 133 + index * 59));
    if (wrapped.truncated && full) {
      context.fillStyle = accentCss;
      context.font = '600 25px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
      context.fillText(this.language === 'zh' ? '单击气泡查看完整消息 ↗' : 'Click the bubble to read the full message ↗', 60, 398);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(full ? 11.6 : 8.2, full ? 5.66 : 2.34, 1);
    sprite.position.set(0, full ? 5.1 : 3.25, 0);
    sprite.renderOrder = full ? 7 : 5;
    sprite.userData.messageCard = true;
    sprite.userData.messageLod = full ? 'full' : 'summary';
    sprite.userData.role = user ? 'user' : 'assistant';
    return sprite;
  }

  private createLabel(entity: SpatialEntity): THREE.Sprite {
    const canvas = document.createElement('canvas');
    // Labels are read at a distance, so a smaller texture is enough and avoids
    // retaining a half-megabyte texture for every visible entity.
    const canvasScale = 0.72;
    canvas.width = 648;
    canvas.height = 107;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Sprite();
    context.scale(canvasScale, canvasScale);
    const palette = this.palette;
    context.fillStyle = palette.label;
    context.beginPath();
    context.roundRect(14, 14, 872, 120, 24);
    context.fill();
    context.strokeStyle = this.theme === 'dark' ? 'rgba(212, 225, 246, .16)' : 'rgba(38, 53, 72, .14)';
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = palette.labelInk;
    context.font = '600 44px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    context.fillText(shortLabel(this.labelForEntity(entity)), 44, 67);
    context.fillStyle = this.theme === 'dark' ? 'rgba(202, 216, 237, .68)' : 'rgba(51, 67, 85, .68)';
    context.font = '500 27px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(labels[this.language][entity.kind].toUpperCase(), 44, 106);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    const messageMarker = entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message';
    sprite.scale.set(messageMarker ? 3.8 : entity.kind === 'file' ? 5.6 : 7.5, messageMarker ? 0.72 : entity.kind === 'file' ? 0.98 : 1.24, 1);
    sprite.position.set(0, entity.kind === 'file' ? 1.55 : 1.82, 0);
    sprite.renderOrder = 4;
    return sprite;
  }

  /** One lightweight world-space card makes the Agent's current intent legible
   * without allocating transcript-sized bubbles or a second side panel. */
  private createActivityBeacon(entity: SpatialEntity): THREE.Sprite {
    const headline = entity.metadata.activityHeadline ?? (this.language === 'zh' ? '等待下一步指令' : 'Waiting for the next instruction');
    const detail = entity.metadata.activityDetail ?? '';
    const state = entity.metadata.activityState ?? 'waiting';
    const accent = state === 'error' ? '#de7287'
      : state === 'running' ? '#efb970'
        : state === 'completed' ? '#70d6bb' : `#${new THREE.Color(this.palette.agent).getHexString()}`;
    const canvas = document.createElement('canvas');
    canvas.width = 756;
    canvas.height = 210;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Sprite();
    const scale = 0.72;
    context.scale(scale, scale);
    context.fillStyle = this.theme === 'dark' ? 'rgba(13, 23, 37, .82)' : 'rgba(252, 251, 247, .88)';
    context.beginPath();
    context.roundRect(18, 18, 1_014, 252, 26);
    context.fill();
    context.strokeStyle = this.theme === 'dark' ? 'rgba(210, 224, 244, .22)' : 'rgba(41, 56, 75, .19)';
    context.lineWidth = 2.5;
    context.stroke();
    context.fillStyle = accent;
    context.beginPath();
    context.arc(52, 58, 9, 0, Math.PI * 2);
    context.fill();
    context.font = '700 22px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    context.fillText((entity.metadata.activityLabel ?? (this.language === 'zh' ? '此刻' : 'NOW')).toUpperCase(), 76, 66);
    context.fillStyle = this.palette.labelInk;
    context.font = '600 36px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    const wrapped = this.bubbleLines(context, headline, 930, detail ? 1 : 2);
    wrapped.lines.forEach((line, index) => context.fillText(line, 48, 126 + index * 45));
    if (detail) {
      context.fillStyle = this.theme === 'dark' ? 'rgba(204, 218, 238, .68)' : 'rgba(48, 63, 81, .64)';
      context.font = '500 24px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.fillText(shortLabel(detail), 48, 226);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(9.2, 2.55, 1);
    sprite.position.set(0, 4.42, 0);
    sprite.renderOrder = 9;
    sprite.userData.activityBeacon = true;
    sprite.userData.activityState = state;
    return sprite;
  }

  private buildEntity(entity: SpatialEntity, withAnnotation: boolean): THREE.Group {
    const color = this.colorForEntity(entity);
    const workActive = entity.metadata.workActive === 'true';
    const workEngaged = workActive || entity.metadata.workCompanion === 'true';
    const replyFocus = entity.metadata.replyFocus === 'true';
    const group = new THREE.Group();
    const visual = new THREE.Group();
    group.userData.entityId = entity.id;
    group.userData.spin = entity.kind === 'agent' ? 0.12 : entity.kind === 'subagent' ? 0.16 : entity.kind === 'tool' ? 0.08 : entity.kind === 'external' ? 0.05 : 0;
    group.userData.rotator = visual;
    group.add(visual);

    if (entity.kind === 'agent' || entity.kind === 'subagent') {
      const main = entity.kind === 'agent';
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(main ? 1.34 : 0.86, 1),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: main ? 0.19 : 0.12, roughness: 0.29, metalness: 0.55 }),
      );
      const core = new THREE.Mesh(new THREE.SphereGeometry(main ? 0.43 : 0.28, 18, 14), new THREE.MeshBasicMaterial({ color: this.theme === 'dark' ? 0xf2f6ff : 0xffffff, transparent: true, opacity: 0.92 }));
      const orbit = new THREE.Mesh(new THREE.TorusGeometry(main ? 0.92 : 0.6, 0.035, 8, 34), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62 }));
      orbit.rotation.x = Math.PI * 0.34;
      orbit.rotation.z = Math.PI * 0.2;
      visual.add(shell, core, orbit);
    } else if (entity.kind === 'file') {
      if (!workEngaged) {
        // A resting artifact remains identifiable but deliberately quiet; its
        // full card appears only while it is being brought to the work area.
        const resting = new THREE.Mesh(
          new THREE.BoxGeometry(1.06, 0.58, 0.1),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.06, roughness: 0.52, metalness: 0.08, transparent: true, opacity: 0.72 }),
        );
        const seam = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.39, 0.08, 0.08), new THREE.Vector3(0.39, 0.08, 0.08)]),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.52 }),
        );
        visual.add(resting, seam);
      } else {
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 1.08, 0.15),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.1, roughness: 0.4, metalness: 0.16, transparent: true, opacity: 0.87 }),
      );
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: this.theme === 'dark' ? 0xefeaff : 0x583d79, transparent: true, opacity: 0.74 }));
      const seam = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.73, 0.18, 0.11), new THREE.Vector3(0.73, 0.18, 0.11)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      visual.add(body, edge, seam);
      }
    } else if (entity.kind === 'tool') {
      if (!workEngaged) {
        // Completed tool calls collapse to a small trace point on the timeline.
        visual.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false })));
      } else {
        const dense = Number(entity.metadata.toolDensity ?? 0) > 18;
        const body = new THREE.Mesh(new THREE.OctahedronGeometry(dense ? 0.68 : 1.03, 0), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.16, roughness: 0.34, metalness: 0.5 }));
        const ringA = new THREE.Mesh(new THREE.TorusGeometry(dense ? 0.86 : 1.32, 0.035, 8, dense ? 20 : 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: dense ? 0.38 : 0.6 }));
        ringA.rotation.x = Math.PI / 2;
        visual.add(body, ringA);
      }
    } else if (entity.kind === 'external') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.04, 0.15, 12, 32), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.12, roughness: 0.28, metalness: 0.36 }));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color }));
      visual.add(ring, dot);
    } else if (entity.kind === 'event') {
      if (entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message') {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.035, 8, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.62, depthWrite: false }));
        ring.rotation.x = Math.PI / 2;
        visual.add(dot, ring);
        if (replyFocus) {
          const aura = new THREE.Mesh(new THREE.TorusGeometry(0.93, 0.018, 8, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.46, depthWrite: false }));
          aura.rotation.x = Math.PI / 2.7;
          visual.add(aura);
        }
      } else if (entity.eventRole === 'agent-start') {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.11, 12, 36), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.24, roughness: 0.3, metalness: 0.32 }));
        ring.rotation.x = Math.PI / 2;
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
        visual.add(ring, core);
      } else {
        const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.72, 0), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.2, roughness: 0.3, metalness: 0.42 }));
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.035, 8, 34), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.66 }));
        halo.rotation.x = Math.PI / 2;
        visual.add(body, halo);
      }
    } else {
      visual.add(new THREE.Mesh(new THREE.TetrahedronGeometry(0.78), new THREE.MeshStandardMaterial({ color, roughness: 0.58 })));
    }
    if (withAnnotation) {
      const messageEvent = entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message';
      if (messageEvent && entity.metadata.messageLod !== 'marker' && entity.metadata.bubbleVisible === 'true') group.add(this.createMessageBubble(entity));
      else group.add(this.createLabel(entity));
    }
    if (entity.id === 'agent-main' && entity.metadata.activityVisible === 'true') group.add(this.createActivityBeacon(entity));
    return group;
  }

  private line(points: THREE.Vector3[], color: number, opacity: number, dashed = false): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.5, gapSize: 0.32 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const line = new THREE.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    return line;
  }

  private relationPath(source: SpatialEntity, target: SpatialEntity, relation: SpatialRelation): THREE.Vector3[] {
    const from = new THREE.Vector3(...source.position);
    const to = new THREE.Vector3(...target.position);
    if (relation.kind === 'read' || relation.kind === 'write') {
      const control = from.clone().lerp(to, 0.5);
      control.y = Math.max(from.y, to.y) + 1.4;
      return new THREE.QuadraticBezierCurve3(from, control, to).getPoints(12);
    }
    if (relation.kind === 'tool-call') {
      const control = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, -1.1, 0));
      return new THREE.QuadraticBezierCurve3(from, control, to).getPoints(9);
    }
    if (relation.kind !== 'delegate' && relation.kind !== 'flow') return [from, to];
    const control = from.clone().lerp(to, 0.5).add(new THREE.Vector3(source.position[0] === target.position[0] ? 1.6 : 0, 1.25, 0));
    return new THREE.QuadraticBezierCurve3(from, control, to).getPoints(14);
  }

  /** A stable, oblique work surface at the current semantic instant. */
  private workbenchPosition(state: SpatialSceneState): THREE.Vector3 {
    // Keep the work surface clearly off the central temporal spine so the
    // Agent's reach and the returning motion are readable at a glance.
    return new THREE.Vector3(-9.2, 2.1, semanticXAtSeq(state, state.cursorSeq) + 2.3);
  }

  private rebuildWorkbench(state: SpatialSceneState): void {
    this.clearLayer(this.workLayer);
    this.workbenchPulse = undefined;
    this.workbenchCore = undefined;
    const active = [...state.entities.values()].find((entity) => entity.metadata.workActive === 'true');
    const color = active ? this.colorForEntity(active) : this.palette.flow;
    const center = this.workbenchPosition(state);
    this.workbenchCenter.copy(center);
    const group = new THREE.Group();
    group.position.copy(center);
    group.rotation.y = -0.22;

    const frame = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 2.18, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: active ? 0.22 : 0.055, side: THREE.DoubleSide, depthWrite: false }),
    );
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 7 }, (_, index) => {
        const angle = Math.PI / 6 + index / 6 * Math.PI * 2;
        return new THREE.Vector3(Math.cos(angle) * 2.2, Math.sin(angle) * 2.2, 0.01);
      })),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: active ? 0.78 : 0.16, depthWrite: false }),
    );
    group.add(frame, outline);
    if (active) {
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(0.48, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.23, side: THREE.DoubleSide, depthWrite: false }),
      );
      const pulse = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.026, 6, 30),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.76, depthWrite: false }),
      );
      group.add(core, pulse);
      this.workbenchCore = core;
      this.workbenchPulse = pulse;
    }
    this.workLayer.add(group);
  }

  private addTether(sourceId: string, targetId: string, kind: SpatialRelation['kind'], style: InteractionTether['style'], phase: number): void {
    if (!this.nodeObjects.has(sourceId) || !this.nodeObjects.has(targetId)) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
    const opacity = style === 'response' ? 0.66 : style === 'primary-work' ? 0.78 : 0.54;
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: this.palette[kind], transparent: true, opacity, depthWrite: false }));
    line.renderOrder = 6;
    this.pulseLayer.add(line);
    const particleCount = style === 'primary-work' ? 3 : style === 'response' ? 2 : 1;
    const particles = Array.from({ length: particleCount }, () => {
      const particle = new THREE.Mesh(new THREE.SphereGeometry(style === 'response' ? 0.075 : 0.09, 8, 6), new THREE.MeshBasicMaterial({ color: this.palette[kind], transparent: true, opacity: 0.82, depthWrite: false }));
      particle.renderOrder = 7;
      this.pulseLayer.add(particle);
      return particle;
    });
    const tether: InteractionTether = {
      line,
      particles,
      sourceId,
      targetId,
      kind,
      style,
      phase,
      burstStartedAt: performance.now(),
      burstDuration: style === 'response' ? 2200 : 2800,
    };
    this.interactionTethers.push(tether);
    this.updateInteractionTether(tether, performance.now());
  }

  /** Current work and the current reply get the only prominent animated links. */
  private rebuildInteractionTethers(state: SpatialSceneState): void {
    const agent = state.entities.get('agent-main');
    if (!agent) return;
    const response = [...state.entities.values()].find((entity) => entity.metadata.replyFocus === 'true');
    if (response) this.addTether(agent.id, response.id, 'flow', 'response', (response.lastSeq % 31) / 31 * Math.PI * 2);
    const target = [...state.entities.values()].find((entity) => entity.metadata.workActive === 'true');
    if (!target) return;
    const relation = [...state.relations.values()]
      .filter((item) => item.startSeq <= state.cursorSeq && (item.sourceId === target.id || item.targetId === target.id))
      .sort((left, right) => Math.abs(left.startSeq - state.cursorSeq) - Math.abs(right.startSeq - state.cursorSeq))[0];
    const kind: SpatialRelation['kind'] = relation?.kind ?? (target.kind === 'tool' ? 'tool-call' : 'read');
    this.addTether(agent.id, target.id, kind, 'primary-work', (state.cursorSeq % 29) / 29 * Math.PI * 2);
    const companion = [...state.entities.values()].find((entity) => entity.metadata.workCompanion === 'true');
    if (companion) this.addTether(agent.id, companion.id, companion.kind === 'tool' ? 'tool-call' : 'write', 'companion-work', (state.cursorSeq % 23) / 23 * Math.PI * 2);
  }

  private updateInteractionTether(tether: InteractionTether, now: number): void {
    const source = this.nodeObjects.get(tether.sourceId);
    const target = this.nodeObjects.get(tether.targetId);
    if (!source || !target) return;
    const positions = tether.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const from = source.position;
    const to = target.position;
    const time = this.reducedMotion ? 0 : now / 2200;
    const lift = tether.style === 'response' ? 1.05 : tether.kind === 'write' ? 1.02 : tether.kind === 'tool-call' ? 0.76 : 0.64;
    for (let index = 0; index < 9; index += 1) {
      const progress = index / 8;
      const envelope = Math.sin(Math.PI * progress);
      const sway = this.reducedMotion ? 0 : Math.sin(time + tether.phase + progress * 5.2) * envelope * 0.15;
      positions.setXYZ(
        index,
        from.x + (to.x - from.x) * progress + sway,
        from.y + (to.y - from.y) * progress + lift * envelope + Math.cos(time * 0.72 + tether.phase + progress * 3.7) * envelope * 0.075,
        from.z + (to.z - from.z) * progress + sway * 0.42,
      );
    }
    positions.needsUpdate = true;
    tether.particles.forEach((particle, index) => {
      // A particle is an event, not wallpaper: it travels once after a state
      // change, then disappears while the quiet relationship line remains.
      const duration = Math.max(1, tether.burstDuration);
      const stagger = index * 0.16;
      const travel = this.reducedMotion ? 0.56 : (now - tether.burstStartedAt) / duration;
      const progress = THREE.MathUtils.clamp((travel - stagger) / Math.max(0.01, 1 - stagger), 0, 1);
      particle.visible = this.reducedMotion || (travel >= stagger && travel <= 1.04);
      if (!particle.visible) return;
      const scaled = progress * 8;
      const low = Math.floor(scaled);
      const high = Math.min(8, low + 1);
      const mix = scaled - low;
      particle.position.set(
        THREE.MathUtils.lerp(positions.getX(low), positions.getX(high), mix),
        THREE.MathUtils.lerp(positions.getY(low), positions.getY(high), mix),
        THREE.MathUtils.lerp(positions.getZ(low), positions.getZ(high), mix),
      );
      particle.scale.setScalar(this.reducedMotion ? 0.72 : 0.56 + Math.sin(progress * Math.PI) * 0.3);
    });
  }

  private createGuideLabel(title: string, detail: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 72;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Sprite();
    context.fillStyle = this.theme === 'dark' ? 'rgba(10, 19, 31, .66)' : 'rgba(251, 250, 246, .72)';
    context.beginPath();
    context.roundRect(5, 5, 410, 62, 17);
    context.fill();
    context.strokeStyle = `#${new THREE.Color(color).getHexString()}`;
    context.globalAlpha = 0.55;
    context.lineWidth = 1.5;
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = this.palette.labelInk;
    context.font = '600 24px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
    context.fillText(title, 18, 31);
    context.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    context.globalAlpha = 0.82;
    context.font = '500 15px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(detail, 18, 53);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(4.35, 0.75, 1);
    sprite.renderOrder = 1;
    return sprite;
  }

  /**
   * The axes are not a grid. They are a handful of semantic surfaces in the
   * current time window: horizontal information strata and vertical causal
   * channel veils, each with a concise in-scene label.
   */
  private rebuildSemanticGuides(state: SpatialSceneState): void {
    this.clearLayer(this.guideLayer);
    const cursorZ = semanticXAtSeq(state, state.cursorSeq);
    const span = 12;
    const yBands = this.language === 'zh'
      ? [
        { y: -1.75, title: '执行层', detail: 'Agent · 工具 · 过程', color: this.palette.tool },
        { y: 1.15, title: '对话层', detail: '用户输入 · Agent 回复', color: this.palette.event },
        { y: 4.15, title: '工件层', detail: '文件 · 外部资源', color: this.palette.file },
      ]
      : [
        { y: -1.75, title: 'EXECUTION', detail: 'Agent · tools · process', color: this.palette.tool },
        { y: 1.15, title: 'DIALOGUE', detail: 'user input · response', color: this.palette.event },
        { y: 4.15, title: 'ARTIFACTS', detail: 'files · external', color: this.palette.file },
      ];
    for (const band of yBands) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(27, span * 2),
        new THREE.MeshBasicMaterial({ color: band.color, transparent: true, opacity: this.theme === 'dark' ? 0.026 : 0.018, side: THREE.DoubleSide, depthWrite: false }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, band.y, cursorZ);
      this.guideLayer.add(plane);
      this.guideLayer.add(this.line(
        [new THREE.Vector3(-12.8, band.y, cursorZ - span), new THREE.Vector3(-12.8, band.y, cursorZ + span)],
        band.color,
        this.theme === 'dark' ? 0.24 : 0.18,
        true,
      ));
      const label = this.createGuideLabel(band.title, band.detail, band.color);
      label.position.set(-12.3, band.y + 0.32, cursorZ - span + 1.45);
      this.guideLayer.add(label);
    }

    const lanes = this.language === 'zh'
      ? [
        { x: -7.4, title: '输入', detail: '用户 · 上游上下文', color: this.palette.external },
        { x: 0, title: '主控', detail: 'Agent · 工具编排', color: this.palette.tool },
        { x: 7.2, title: '结果', detail: '回复 · 分支输出', color: this.palette.agent },
      ]
      : [
        { x: -7.4, title: 'INPUT', detail: 'user · upstream context', color: this.palette.external },
        { x: 0, title: 'CONTROL', detail: 'Agent · orchestration', color: this.palette.tool },
        { x: 7.2, title: 'OUTCOME', detail: 'response · branch output', color: this.palette.agent },
      ];
    for (const lane of lanes) {
      const veil = new THREE.Mesh(
        new THREE.PlaneGeometry(1.15, span * 2),
        new THREE.MeshBasicMaterial({ color: lane.color, transparent: true, opacity: this.theme === 'dark' ? 0.032 : 0.022, side: THREE.DoubleSide, depthWrite: false }),
      );
      veil.rotation.y = Math.PI / 2;
      veil.position.set(lane.x, 1.6, cursorZ);
      this.guideLayer.add(veil);
      this.guideLayer.add(this.line(
        [new THREE.Vector3(lane.x, -2.55, cursorZ), new THREE.Vector3(lane.x, 5.9, cursorZ)],
        lane.color,
        this.theme === 'dark' ? 0.35 : 0.27,
        true,
      ));
      const label = this.createGuideLabel(lane.title, lane.detail, lane.color);
      label.position.set(lane.x, 6.25, cursorZ + 0.25);
      label.scale.multiplyScalar(0.82);
      this.guideLayer.add(label);
    }
  }

  private rebuildStations(state: SpatialSceneState): void {
    this.clearLayer(this.stationLayer);
    const cursorZ = semanticXAtSeq(state, state.cursorSeq);
    for (const station of state.stations) {
      const future = station.startSeq > state.cursorSeq;
      const active = station.startSeq <= state.cursorSeq && station.endSeq >= state.cursorSeq;
      const opacity = active ? 0.72 : future ? 0.16 : 0.34;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -0.58, station.startX + 0.8),
        new THREE.Vector3(Math.sin(station.index * 1.7) * 0.65, -0.84, station.centerX),
        new THREE.Vector3(0, -0.58, station.endX - 0.8),
      ]);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, active ? 26 : 14, 0.075, 5, false),
        new THREE.MeshBasicMaterial({ color: this.palette.flow, transparent: true, opacity, depthWrite: false }),
      );
      this.stationLayer.add(tube);
      // Only the current station needs a soft halo; applying it to all history
      // doubles tube geometry while adding little orientation value.
      if (active) {
        const halo = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 20, 0.18, 5, false),
          new THREE.MeshBasicMaterial({ color: this.palette.flow, transparent: true, opacity: opacity * 0.12, depthWrite: false }),
        );
        this.stationLayer.add(halo);
      }
      const laneOpacity = active ? 0.2 : future ? 0.045 : 0.1;
      const laneStart = station.startX + 0.8;
      const laneEnd = station.endX - 0.8;
      const lanes = [
        { x: -7.4, y: 1.2, color: this.palette.external },
        { x: 0, y: -2.15, color: this.palette.tool },
        { x: 7.2, y: 1.35, color: this.palette.agent },
      ];
      for (const lane of lanes) {
        this.stationLayer.add(this.line(
          [new THREE.Vector3(lane.x, lane.y, laneStart), new THREE.Vector3(lane.x, lane.y, laneEnd)],
          lane.color,
          laneOpacity,
          true,
        ));
      }
      // The active station alone receives a small number of depth rings. They
      // explain the current corridor without allocating decorative geometry for
      // every historical turn.
      if (!active) continue;
      for (const progress of [0, 0.5, 1]) {
        const point = curve.getPoint(progress);
        if (Math.abs(point.z - cursorZ) < 0.5) continue;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(2.3, 0.025, 6, 28),
          new THREE.MeshBasicMaterial({ color: this.palette.flow, transparent: true, opacity: opacity * (progress === 0 || progress === 1 ? 0.28 : 0.14), depthWrite: false }),
        );
        ring.scale.set(3.0, 0.78, 1);
        ring.position.copy(point);
        this.stationLayer.add(ring);
      }
    }

    // The current semantic instant is a portal across the time corridor.
    const portal = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.045, 10, 64),
      new THREE.MeshBasicMaterial({ color: this.palette.flow, transparent: true, opacity: 0.88, depthWrite: false }),
    );
    portal.scale.set(2.8, 1.0, 1);
    portal.position.set(0, 0.25, cursorZ);
    this.stationLayer.add(portal);
  }

  /**
   * A tiny, bounded force field for the live workbench. Semantic Z positions
   * are never simulated: only the three temporary visual anchors (Agent,
   * primary artifact and companion) are allowed to avoid one another.
   */
  private relaxWorkbench(delta: number): void {
    const participants = [...this.nodeObjects.values()].filter((object) => object.userData.workspaceAnchor instanceof THREE.Vector3);
    if (participants.length < 2) return;
    const corrections = new Map<THREE.Group, THREE.Vector3>();
    for (const object of participants) corrections.set(object, new THREE.Vector3());
    for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < participants.length; rightIndex += 1) {
        const left = participants[leftIndex];
        const right = participants[rightIndex];
        const direction = left.position.clone().sub(right.position);
        const distance = Math.max(0.001, direction.length());
        const desiredDistance = 2.18;
        if (distance >= desiredDistance) continue;
        direction.multiplyScalar(1 / distance);
        const strength = (desiredDistance - distance) / desiredDistance * Math.min(0.22, delta * 2.7);
        corrections.get(left)!.addScaledVector(direction, strength);
        corrections.get(right)!.addScaledVector(direction, -strength);
      }
    }
    for (const object of participants) {
      const anchor = object.userData.workspaceAnchor as THREE.Vector3;
      const target = object.userData.motionTarget as THREE.Vector3;
      // Soft spring back to role anchor: the field settles rather than jitters.
      target.lerp(anchor, Math.min(1, delta * 0.68));
      target.add(corrections.get(object)!);
    }
  }

  private rebuild(state: SpatialSceneState): void {
    this.clearLayer(this.nodeLayer);
    this.clearLayer(this.relationLayer);
    this.clearLayer(this.pulseLayer);
    this.rebuildSemanticGuides(state);
    this.rebuildStations(state);
    this.rebuildWorkbench(state);
    this.nodeObjects.clear();
    this.nodeKinds.clear();
    this.pulseObjects = [];
    this.interactionTethers = [];
    this.messageCards = [];
    const showEveryLabel = state.entities.size <= 60;
    const workInProgress = [...state.entities.values()].some((entity) => entity.metadata.workActive === 'true');
    const activeEntityIds = new Set<string>();
    for (const entity of state.entities.values()) {
      const temporalPhase = entity.metadata.temporalPhase ?? 'past';
      const temporalDistance = Math.abs(Number(entity.metadata.temporalDistance ?? 0));
      const workActive = entity.metadata.workActive === 'true';
      const workCompanion = entity.metadata.workCompanion === 'true';
      const workEngaged = workActive || workCompanion;
      const workspaceRole = entity.id === 'agent-main' && workInProgress ? 'agent'
        : workActive ? 'primary'
          : workCompanion ? 'companion' : undefined;
      const replyFocus = entity.metadata.replyFocus === 'true';
      const ambientArtifact = (entity.kind === 'tool' || entity.kind === 'file') && !workEngaged;
      const eventPriority = entity.kind === 'event' && (entity.metadata.stationFocus === 'true' || entity.metadata.messageLod !== 'marker');
      const keepLabel = temporalPhase !== 'future' && (entity.kind === 'agent' || entity.kind === 'subagent' || eventPriority
        || (entity.kind === 'file' && entity.metadata.labelVisible === 'true')
        || entity.metadata.labelVisible === 'true');
      const messageCard = (entity.eventRole === 'user-message' || entity.eventRole === 'assistant-message')
        && entity.metadata.messageLod !== 'marker' && entity.metadata.bubbleVisible === 'true';
      // Do not allocate an offscreen canvas and GPU texture only to hide it a
      // few lines later. Nodes remain pickable and their details are unchanged.
      const showArtifactLabel = entity.kind === 'file' && entity.metadata.labelVisible === 'true' && temporalDistance <= 2;
      const object = this.buildEntity(entity, messageCard || workEngaged || showArtifactLabel || (!ambientArtifact && (showEveryLabel || keepLabel)));
      const targetPosition = new THREE.Vector3(...entity.position);
      if (workspaceRole === 'agent') targetPosition.copy(this.workbenchCenter).add(new THREE.Vector3(3.35, -1.18, 0.48));
      else if (workspaceRole === 'primary') targetPosition.copy(this.workbenchCenter).add(new THREE.Vector3(-0.28, 0.28, 0.18));
      else if (workspaceRole === 'companion') targetPosition.copy(this.workbenchCenter).add(new THREE.Vector3(1.32, -0.34, 0.1));
      const previousPosition = this.motionPositions.get(entity.id);
      object.position.copy(previousPosition ?? targetPosition);
      object.userData.motionTarget = targetPosition;
      if (workspaceRole) object.userData.workspaceAnchor = targetPosition.clone();
      object.userData.motionSpeed = workspaceRole ? 0.46 : workEngaged ? 0.52 : entity.kind === 'agent' ? 0.72 : entity.kind === 'file' || entity.kind === 'tool' ? 1.05 : 1.8;
      const toolDensity = Number(entity.metadata.toolDensity ?? 0);
      const baseScale = entity.kind === 'file'
        ? (workEngaged ? Math.min(1.1, 0.88 + Math.log2(1 + (entity.importance ?? 1)) * 0.08) : 0.72)
        : entity.kind === 'tool' ? (workEngaged ? (toolDensity > 24 ? 0.64 : 0.94) : 0.48) : entity.kind === 'agent' ? 0.78 : 1;
      const temporalScale = temporalPhase === 'current' ? 1.12 : temporalPhase === 'future' ? 0.62 : temporalPhase === 'memory' ? 0.94 : Math.max(0.62, 1 - temporalDistance * 0.045);
      const resolvedScale = baseScale * temporalScale * (workspaceRole ? 1.12 : workEngaged ? 1.16 : replyFocus ? 1.1 : 1);
      object.userData.baseScale = resolvedScale;
      object.scale.setScalar(resolvedScale);
      const phaseOpacity = temporalPhase === 'future' ? 0.17 : temporalPhase === 'memory' ? 0.86 : temporalPhase === 'current' ? 1 : Math.max(0.3, 0.88 - temporalDistance * 0.055);
      const temporalOpacity = phaseOpacity * (ambientArtifact ? entity.kind === 'tool' ? 0.32 : 0.54 : 1);
      multiplyObjectOpacity(object, temporalOpacity);
      this.nodeLayer.add(object);
      this.nodeObjects.set(entity.id, object);
      this.nodeKinds.set(entity.id, entity.kind);
      activeEntityIds.add(entity.id);
      const card = object.children.find((child) => child instanceof THREE.Sprite && child.userData.messageCard === true) as THREE.Sprite | undefined;
      if (card) this.messageCards.push({
        sprite: card,
        group: object,
        priority: entity.metadata.messageLod === 'full' ? 3 : entity.metadata.stationFocus === 'true' ? 2 : 1,
        role: entity.eventRole === 'user-message' ? 'user' : 'assistant',
      });
      if ((entity.kind === 'agent' || entity.kind === 'subagent') && entity.trail.length > 1) {
        const stride = Math.max(1, Math.ceil(entity.trail.length / 180));
        const trail = entity.trail.filter((_, index) => index === 0 || index === entity.trail.length - 1 || index % stride === 0);
        this.nodeLayer.add(this.line(trail.map((point) => new THREE.Vector3(...point)), this.colorForEntity(entity), entity.kind === 'agent' ? 0.72 : 0.26, entity.kind === 'subagent'));
      }
    }
    for (const id of this.motionPositions.keys()) {
      if (!activeEntityIds.has(id)) this.motionPositions.delete(id);
    }
    for (const relation of state.relations.values()) {
      const source = state.entities.get(relation.sourceId);
      const target = state.entities.get(relation.targetId);
      if (!source || !target) continue;
      // Dense stations use the execution belt and its flow chain; drawing an
      // additional hub-to-tool fan would encode the same fact as visual noise.
      if (relation.kind === 'tool-call' && Number(target.metadata.toolDensity ?? 0) > 12) continue;
      const path = this.relationPath(source, target, relation);
      const targetPhase = target.metadata.temporalPhase;
      const phaseOpacity = targetPhase === 'future' ? 0.14 : targetPhase === 'current' ? 1 : 0.58;
      const activeRelation = source.metadata.workActive === 'true' || target.metadata.workActive === 'true'
        || source.metadata.workCompanion === 'true' || target.metadata.workCompanion === 'true';
      const opacity = (activeRelation
        ? relation.kind === 'write' ? 0.28 : relation.kind === 'tool-call' ? 0.22 : 0.18
        : relation.kind === 'flow' ? 0.3 : relation.kind === 'delegate' ? 0.18 : relation.kind === 'write' ? 0.09 : relation.kind === 'tool-call' ? 0.065 : 0.04) * phaseOpacity;
      this.relationLayer.add(this.line(path, this.palette[relation.kind], opacity, relation.kind === 'read'));
      if (relation.state !== 'active' || !activeRelation) continue;
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(relation.kind === 'delegate' ? 0.21 : 0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: this.palette[relation.kind], transparent: true, opacity: 0.94, depthWrite: false }),
      );
      pulse.userData.relationId = relation.id;
      this.pulseLayer.add(pulse);
      this.pulseObjects.push({ mesh: pulse, relation, phase: (relation.startSeq % 17) / 17, startedAt: performance.now(), duration: 2300 });
    }
    this.rebuildInteractionTethers(state);
    this.applySelection();
  }

  private applySelection(): void {
    this.clearLayer(this.selectionLayer);
    for (const object of this.nodeObjects.values()) object.scale.setScalar(Number(object.userData.baseScale ?? 1));
    if (!this.selectedId) return;
    const selected = this.nodeObjects.get(this.selectedId);
    const kind = this.nodeKinds.get(this.selectedId);
    if (!selected || !kind) return;
    selected.scale.setScalar(Number(selected.userData.baseScale ?? 1) * 1.12);
    const halo = new THREE.Group();
    const entity = this.state?.entities.get(this.selectedId);
    const color = entity ? this.colorForEntity(entity) : this.palette[kind];
    const outer = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.035, 8, 54), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.TorusGeometry(1.68, 0.02, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.48, depthWrite: false }));
    outer.rotation.x = Math.PI / 2;
    inner.rotation.x = Math.PI / 2.7;
    halo.add(outer, inner);
    halo.position.copy(selected.position);
    halo.userData.selectionHalo = true;
    this.selectionLayer.add(halo);
  }

  setState(state: SpatialSceneState): void {
    const cursorCoordinate = semanticXAtSeq(state, state.cursorSeq);
    const shouldFollowTimeline = this.initialFramed && this.latestCursorCoordinate !== undefined
      && Math.abs(this.controls.target.z - this.latestCursorCoordinate) < 13;
    this.state = state;
    this.rebuild(state);
    if (!this.initialFramed) {
      this.controls.target.set(0, 0.6, cursorCoordinate);
      this.camera.position.set(18, 10.8, cursorCoordinate + 21);
      this.initialFramed = true;
    } else if (shouldFollowTimeline) {
      const deltaZ = cursorCoordinate - this.latestCursorCoordinate!;
      this.controls.target.z += deltaZ;
      this.camera.position.z += deltaZ;
    }
    this.latestCursorCoordinate = cursorCoordinate;
  }

  setReducedMotion(value: boolean): void { this.reducedMotion = value; }

  setTheme(value: Theme): void {
    if (this.theme === value) return;
    this.theme = value;
    this.applyTheme();
    this.buildEnvironment();
    if (this.state) this.rebuild(this.state);
  }

  setLanguage(value: Language): void {
    if (this.language === value) return;
    this.language = value;
    if (this.state) this.rebuild(this.state);
  }

  setSelectedEntity(id?: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.applySelection();
  }

  /** A deliberate double-click action; ordinary selection never changes the viewpoint. */
  focusEntity(id: string): void {
    const object = this.nodeObjects.get(id);
    if (!object) return;
    const target = object.position.clone();
    this.focusTarget = {
      target,
      position: target.clone().add(new THREE.Vector3(11.5, 7.8, 13.5)),
    };
  }

  /** Travel through semantic depth while preserving the user's orbit and zoom. */
  moveToTimelineSeq(seq: number, _startSeq: number, _endSeq: number): void {
    const z = this.state ? semanticXAtSeq(this.state, seq) : 0;
    const deltaZ = z - this.controls.target.z;
    this.focusTarget = {
      target: this.controls.target.clone().add(new THREE.Vector3(0, 0, deltaZ)),
      position: this.camera.position.clone().add(new THREE.Vector3(0, 0, deltaZ)),
    };
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth ?? this.canvas.clientWidth;
    const height = parent?.clientHeight ?? this.canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private pick(event: PointerEvent | MouseEvent): { id?: string; anchor: { x: number; y: number } } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointer.set(x, y);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.nodeObjects.values()], true);
    // Message cards are deliberately drawn above the scene (depthTest is off).
    // Mirror that visual order in picking so a file or tool behind the card does
    // not steal the click intended to open its Markdown reader.
    const messageHit = hits.find(({ object }) => {
      let current: THREE.Object3D | undefined = object;
      while (current) {
        if (current.userData.messageCard === true) return true;
        current = current.parent ?? undefined;
      }
      return false;
    });
    const hit = (messageHit ?? hits[0])?.object;
    let owner: THREE.Object3D | undefined = hit;
    while (owner && typeof owner.userData.entityId !== 'string') owner = owner.parent ?? undefined;
    return {
      id: typeof owner?.userData.entityId === 'string' ? owner.userData.entityId : undefined,
      anchor: {
        x: Math.max(4, Math.min(88, ((event.clientX - rect.left) / rect.width) * 100)),
        y: Math.max(7, Math.min(78, ((event.clientY - rect.top) / rect.height) * 100)),
      },
    };
  }

  private handlePointerDown = (event: PointerEvent): void => { this.pointerDown = { x: event.clientX, y: event.clientY }; };

  private handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = undefined;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
    const picked = this.pick(event);
    this.onSelect?.(picked.id, picked.anchor);
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    const picked = this.pick(event);
    if (picked.id) this.focusEntity(picked.id);
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
  };

  private handleContextRestored = (): void => {
    this.resize();
    this.buildEnvironment();
    if (this.state) this.rebuild(this.state);
    this.frame = requestAnimationFrame(this.animate);
  };

  /** Resolve annotation collisions in screen space while nodes remain in deterministic world-space lanes. */
  private layoutMessageCards(): void {
    if (!this.messageCards.length) return;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    const cards = [...this.messageCards].sort((left, rightCard) => rightCard.priority - left.priority || left.group.position.x - rightCard.group.position.x);
    const projectRect = (center: THREE.Vector3, halfWidth: number, halfHeight: number) => {
      const corners = [
        center.clone().addScaledVector(right, -halfWidth).addScaledVector(up, halfHeight),
        center.clone().addScaledVector(right, halfWidth).addScaledVector(up, -halfHeight),
      ].map((point) => point.project(this.camera));
      return {
        left: ((corners[0].x + 1) * 0.5) * width,
        right: ((corners[1].x + 1) * 0.5) * width,
        top: ((1 - corners[0].y) * 0.5) * height,
        bottom: ((1 - corners[1].y) * 0.5) * height,
      };
    };
    const overlapArea = (candidate: { left: number; right: number; top: number; bottom: number }, existing: { left: number; right: number; top: number; bottom: number }) => {
      const overlapWidth = Math.max(0, Math.min(candidate.right, existing.right) - Math.max(candidate.left, existing.left));
      const overlapHeight = Math.max(0, Math.min(candidate.bottom, existing.bottom) - Math.max(candidate.top, existing.top));
      return overlapWidth * overlapHeight;
    };

    for (const card of cards) {
      const full = card.priority === 3;
      const side = card.role === 'user' ? -1 : 1;
      const candidates: Array<[number, number]> = full
        ? [[side * 3.2, 5.3], [0, 7.8], [side * 6.4, 6.1], [-side * 5.6, 7.2]]
        : [[side * 2.4, 3.25], [side * 5.1, 4.1], [0, 5.2], [-side * 4.8, 4.4]];
      let best: { offset: THREE.Vector3; rect: { left: number; right: number; top: number; bottom: number }; score: number } | undefined;
      for (const [horizontal, vertical] of candidates) {
        const offset = right.clone().multiplyScalar(horizontal).addScaledVector(up, vertical);
        const center = card.group.position.clone().add(offset);
        const rect = projectRect(center, card.sprite.scale.x / 2, card.sprite.scale.y / 2);
        const outside = Math.max(0, 8 - rect.left) + Math.max(0, rect.right - width + 8)
          + Math.max(0, 8 - rect.top) + Math.max(0, rect.bottom - height + 8);
        const overlap = occupied.reduce((sum, existing) => sum + overlapArea(rect, existing), 0);
        const score = overlap + outside * 180;
        if (!best || score < best.score) best = { offset, rect, score };
        if (score === 0) break;
      }
      if (!best) continue;
      const hideSummary = !full && best.score > 6_000;
      card.sprite.visible = !hideSummary;
      if (hideSummary) continue;
      card.sprite.position.copy(best.offset);
      occupied.push(best.rect);
    }
  }

  private animate = (now: number): void => {
    const delta = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    this.relaxWorkbench(delta);
    for (const [id, object] of this.nodeObjects) {
      const target = object.userData.motionTarget as THREE.Vector3 | undefined;
      if (target) {
        // Event ingestion is intentionally slower than a UI diff.  It makes a
        // new model action feel like an observed movement through the workspace.
        const speed = Number(object.userData.motionSpeed ?? 1.6);
        object.position.lerp(target, 1 - Math.exp(-delta * speed));
        const remembered = this.motionPositions.get(id) ?? new THREE.Vector3();
        remembered.copy(object.position);
        this.motionPositions.set(id, remembered);
      }
      const spin = Number(object.userData.spin ?? 0);
      const rotator = object.userData.rotator as THREE.Group | undefined;
      if (!this.reducedMotion && spin && rotator) {
        rotator.rotation.y += delta * spin;
        rotator.rotation.x += delta * spin * 0.35;
      }
      for (const child of object.children) {
        if (!(child instanceof THREE.Sprite) || child.userData.activityBeacon !== true) continue;
        const material = child.material as THREE.SpriteMaterial;
        const active = child.userData.activityState === 'running';
        material.opacity = this.reducedMotion || !active ? 1 : 0.88 + (Math.sin(now / 920) + 1) * 0.06;
        child.position.y = 4.42 + (this.reducedMotion || !active ? 0 : Math.sin(now / 1220) * 0.055);
      }
    }
    for (const tether of this.interactionTethers) this.updateInteractionTether(tether, now);
    if (this.workbenchPulse) {
      const breath = this.reducedMotion ? 1 : 1 + Math.sin(now / 980) * 0.055;
      this.workbenchPulse.scale.setScalar(breath);
      this.workbenchPulse.rotation.z += this.reducedMotion ? 0 : delta * 0.07;
    }
    if (this.workbenchCore) {
      const material = this.workbenchCore.material as THREE.MeshBasicMaterial;
      material.opacity = this.reducedMotion ? 0.22 : 0.17 + (Math.sin(now / 880) + 1) * 0.045;
    }
    for (const pulse of this.pulseObjects) {
      const source = this.nodeObjects.get(pulse.relation.sourceId);
      const target = this.nodeObjects.get(pulse.relation.targetId);
      if (!source || !target) continue;
      const phase = this.reducedMotion ? 0.52 : THREE.MathUtils.clamp((now - pulse.startedAt) / pulse.duration, 0, 1);
      pulse.mesh.visible = this.reducedMotion || phase < 1;
      if (!pulse.mesh.visible) continue;
      pulse.mesh.position.lerpVectors(source.position, target.position, phase);
      pulse.mesh.scale.setScalar(this.reducedMotion ? 0.72 : 0.48 + Math.sin(phase * Math.PI) * 0.58);
    }
    for (const halo of this.selectionLayer.children) {
      const motion = this.reducedMotion ? 0 : Math.sin(now / 1100) * 0.028;
      const selected = this.selectedId ? this.nodeObjects.get(this.selectedId) : undefined;
      if (selected && halo.userData.selectionHalo === true) halo.position.copy(selected.position);
      halo.rotation.y += this.reducedMotion ? 0 : delta * 0.16;
      halo.scale.setScalar(1 + motion);
    }
    if (this.focusTarget) {
      this.controls.target.lerp(this.focusTarget.target, 0.043);
      this.camera.position.lerp(this.focusTarget.position, 0.043);
      if (this.controls.target.distanceTo(this.focusTarget.target) < 0.03 && this.camera.position.distanceTo(this.focusTarget.position) < 0.05) this.focusTarget = undefined;
    }
    this.controls.update();
    this.environmentLayer.position.x = this.controls.target.x;
    this.environmentLayer.position.z = this.controls.target.z;
    this.layoutMessageCards();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  private clearLayer(layer: THREE.Group): void {
    while (layer.children.length) {
      const object = layer.children[0];
      layer.remove(object);
      object.traverse((child) => {
        const disposable = child as DisposableObject;
        disposable.geometry?.dispose();
        if (Array.isArray(disposable.material)) disposable.material.forEach(disposeMaterial);
        else if (disposable.material) disposeMaterial(disposable.material);
      });
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.resizeFrame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.clearLayer(this.environmentLayer);
    this.clearLayer(this.guideLayer);
    this.clearLayer(this.stationLayer);
    this.clearLayer(this.workLayer);
    this.clearLayer(this.relationLayer);
    this.clearLayer(this.pulseLayer);
    this.clearLayer(this.nodeLayer);
    this.clearLayer(this.selectionLayer);
    this.renderer.dispose();
  }
}
