/**
 * DysonSwarmCentralMap — standalone sun-centered / local-area vector map.
 *
 * Framework and dependency free ES module. Uses a Canvas 2D renderer with genuine
 * 3D world coordinates and perspective projection. The vector renderer deliberately
 * replaces the original Three.js geometry so this prototype can run offline.
 *
 * It is a VIEW, not a simulation: locations do not orbit, ships do not move on
 * their own, and the consuming game owns all knowledge, travel and state changes.
 *
 * new DysonSwarmCentralMap(container, { world, onSelect, onViewChange });
 * map.setWorld({ entities, routes, playerLocationId });
 * map.updateEntity(id, { position: { x,y,z } });  // external simulation tick
 * map.select(id); map.inspect(id); map.enterLocal(id); map.returnToSwarm();
 * Optional entity.actions: [{id,label,enabled}]; onAction({entityId,actionId}).
 * map.setOverlay('physical' | 'navigation' | 'influence'); map.destroy();
 *
 * Entity: { id, type: 'station'|'asteroid'|'ship'|'megastructure'|'factory'|'wreck',
 *   position:{x,y,z}, name?, visibility?:'signal'|'identified'|'surveyed',
 *   detail?, subtitle?, areaId?, scale?, color?, authored?, actions?,
 *   structure?: { azStart, azEnd, elevation, height, radius, gaps? } }
 * IMPORTANT: The provided entities must already be filtered to the observer's
 * knowledge. No secret, undiscovered world data should be passed to a UI view.
 *
 * Embedded (game shell) mode — options.uiMode = 'embedded':
 *   Renders only the canvas; the host shell owns HUD, context panel and actions.
 *   Entity ids should be opaque display ids; entity.label (when supplied) is the
 *   only text drawn, and labels never fall back to ids.
 *   entity.presentation = { stale:true, ageText } draws a ghosted last-known glyph.
 *   entity.direction = {x,y,z} (unit, world space) orients a ship glyph along its motion.
 * Options: uiMode, overlays[], labelInsets{left,right,top,bottom}, localRadius,
 *   localCameraDistance (number, or (width, height) => number for aspect-aware framing). Extra methods: getView(), viewIds(), visibleIds(),
 *   screenPositionOf(id), select(id,{notify}), setInteractive(bool).
 */
const TYPE_WORD={station:'STATION',asteroid:'ASTEROID',ship:'VESSEL',megastructure:'STRUCTURE',factory:'FACILITY',wreck:'WRECK'};

/**
 * Screen angle for a ship glyph whose nose points up (−y), from the projected positions of
 * its location and a point ahead of it. Pure; falls back when either point is unprojectable.
 */
export function screenHeading(p,q,fallback=0){
  if(!p||!q)return fallback;
  const dx=q.x-p.x,dy=q.y-p.y;
  if(!(Math.abs(dx)+Math.abs(dy)>1e-9))return fallback;
  return Math.atan2(dx,-dy);
}

/** Pure perspective projection used by the renderer (exported for tests). */
export function projectPoint(camera,position,w,h){
  const c=camera;
  const d={x:position.x-c.x,y:position.y-c.y,z:position.z-c.z};
  const sy=Math.sin(c.yaw),cy=Math.cos(c.yaw),sp=Math.sin(c.pitch),cp=Math.cos(c.pitch);
  const x=d.x*cy-d.z*sy;
  const y=d.y*cp-(d.x*sy+d.z*cy)*sp;
  const z=(d.x*sy+d.z*cy)*cp+d.y*sp;
  if(z<.3)return null;
  const f=h*.5/Math.tan(c.fov*Math.PI/360);
  return {x:w/2+x*f/z,y:h/2-y*f/z,z,scale:f/z};
}

/**
 * Kept cells of a megastructure footprint (gap cells removed), with panel boundaries
 * marked so ribs can frame each contiguous panel. Pure; exported for tests.
 */
export function structureCells(s){
  const gaps=s.gaps||[];
  const segments=Math.max(5,Math.ceil(Math.abs(s.azEnd-s.azStart)/2.7));
  const skip=Array.from({length:segments},(_,i)=>{const tm=(i+.5)/segments;return gaps.some(([a,b])=>tm>=a&&tm<=b);});
  const cells=[];
  for(let i=0;i<segments;i++){
    if(skip[i])continue;
    cells.push({i,azA:s.azStart+(s.azEnd-s.azStart)*i/segments,azB:s.azStart+(s.azEnd-s.azStart)*(i+1)/segments,
      panelStart:i===0||skip[i-1],panelEnd:i===segments-1||skip[i+1]});
  }
  return cells;
}

/** Presentation-only star at the world origin (world units). Not an entity; never picked or counted. */
// hideWithin: no Local View camera comes this close (nearest ≈386 wu), but the swarm vantage at the origin does.
const SUN={radius:180,corona:3.2,hideWithin:360};
/**
 * Screen disc of the star, drawn only in Local View; null when behind the camera, off-screen, or while the
 * camera is still near the star (the swarm vantage sits at the origin). Pure; exported for tests.
 */
export function sunDisc(camera,mode,w,h){
  if(mode!=='local')return null;
  if(Math.hypot(camera.x,camera.y,camera.z)<SUN.hideWithin)return null;
  const p=projectPoint(camera,{x:0,y:0,z:0},w,h);
  if(!p)return null;
  const r=SUN.radius*p.scale,reach=r*SUN.corona;
  if(p.x<-reach||p.x>w+reach||p.y<-reach||p.y>h+reach)return null;
  return {x:p.x,y:p.y,r};
}

export class DysonSwarmCentralMap {
  static spherical(azimuth, elevation, radius) {
    const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
    return { x: Math.sin(a) * Math.cos(e) * radius,
             y: Math.sin(e) * radius,
             z: Math.cos(a) * Math.cos(e) * radius };
  }

  constructor(container, options = {}) {
    if (!(container instanceof HTMLElement)) throw new Error('Provide a container HTMLElement');
    this.container = container;
    this.options = { sensitivity: 0.004, uiMode: 'standalone', overlays: ['physical','navigation','influence'],
      labelInsets: null, localRadius: 200, localCameraDistance: 125, ...options };
    this.embedded = this.options.uiMode === 'embedded';
    this.interactive = true;
    this._screen = new Map();
    this.world = { entities: [], routes: [], playerLocationId: null };
    this.entities = new Map();
    this.selectedId = null;
    this.hoverId = null;
    this.overlay = 'physical';
    this.mode = 'swarm';
    this.localAreaId = null;
    this.time = 0;
    this._sunAlpha = 0;
    this.running = true;
    this.disposed = false;
    this.pointer = null;
    this.hits = [];
    this.w = 1;
    this.h = 1;
    this.pixelRatio = 1;
    this.camera = { x:0, y:0, z:0, yaw:0.46, pitch:-0.07, fov:64 };
    this.targetCamera = { ...this.camera };
    this.selectionCallback = this.options.onSelect || (() => {});
    this.viewCallback = this.options.onViewChange || (() => {});
    this.actionCallback = this.options.onAction || (() => {});
    this._injectStyles();
    this._createDOM();
    this._bindEvents();
    this.setWorld(this.options.world || this.world);
    this.resize();
    this._lastTime = performance.now();
    this._frame = requestAnimationFrame(t => this._tick(t));
  }

  _injectStyles() {
    if (document.getElementById('ds-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'ds-map-styles';
    style.textContent = `
      .dsm{--cyan:#70d7dd;--dim:#6b95a6;--green:#42d7a3;--gold:#f3bd65;--line:#1a3947;
        position:relative;width:100%;height:100%;min-height:440px;overflow:hidden;background:#050c12;
        font-family:'IBM Plex Mono','Courier New',monospace;color:#d4e9ed;isolation:isolate;user-select:none}
      .dsm--embedded{min-height:0}
      .dsm *{box-sizing:border-box}.dsm canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none}
      .dsm canvas:active{cursor:grabbing}.dsm button{font:inherit;cursor:pointer;color:inherit}
      .dsm button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
      .dsm-chrome{position:absolute;z-index:2;pointer-events:none;inset:0}
      .dsm-chrome button,.dsm-panel,.dsm-toolbar,.dsm-top,.dsm-bottom{pointer-events:auto}
      .dsm-top{height:57px;display:flex;align-items:center;gap:14px;padding:0 19px;
        background:linear-gradient(180deg,rgba(5,14,20,.96),rgba(5,14,20,.77));border-bottom:1px solid #204753}
      .dsm-brand{font-size:13px;font-weight:800;letter-spacing:1.9px;color:#b0f0ee;white-space:nowrap}
      .dsm-brand small{font-size:9px;color:#4b8a92;letter-spacing:1.2px;display:block;margin-top:3px}
      .dsm-breadcrumb{font-size:10px;color:#7ea7b5;border-left:1px solid #274654;padding-left:14px;white-space:nowrap}
      .dsm-toolbar{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:nowrap}
      .dsm-btn{border:1px solid #2b505e;background:#0e202a;border-radius:3px;min-height:29px;padding:6px 10px;
        color:#a9d4df!important;letter-spacing:.4px;font-size:10px;white-space:nowrap;transition:background .15s,border .15s}
      .dsm-btn:hover{background:#173644;border-color:#56adb7}.dsm-btn[aria-pressed=true]{background:#15434b;border-color:#63c6bd;color:#a9ffed!important}
      .dsm-btn:disabled{opacity:.35;cursor:not-allowed}.dsm-btn-amber{border-color:#8d7046;color:#ffcf88!important}
      .dsm-left{position:absolute;top:79px;left:18px;width:246px;max-width:calc(100% - 36px);pointer-events:auto}
      .dsm-panel{background:rgba(7,20,28,.92);border:1px solid #235061;box-shadow:0 8px 26px #0008, inset 0 1px #34647544;border-radius:4px;backdrop-filter:blur(9px)}
      .dsm-left .dsm-panel{padding:15px}.dsm-eyebrow{font-size:9px;color:#4faeae;letter-spacing:1.5px;font-weight:bold}
      .dsm-mainlabel{margin-top:9px;font-size:18px;letter-spacing:.5px;color:#e0f5f6;font-weight:700}
      .dsm-descr{font-size:10.5px;color:#88a7b0;line-height:1.75;margin-top:8px}
      .dsm-separator{border-top:1px solid #203d48;margin:13px 0}
      .dsm-statrow{display:flex;justify-content:space-between;font-size:10px;gap:8px;margin:9px 0;color:#7393a0}
      .dsm-statrow strong{color:#b5dce5;font-weight:600}.dsm-legend{display:flex;align-items:center;gap:10px;font-size:10px;color:#a2b7bb;margin:9px 0}
      .dsm-swatch{width:10px;height:10px;border:1px solid currentColor;display:inline-block}
      .dsm-right{position:absolute;right:18px;top:79px;width:282px;max-width:calc(100% - 36px);pointer-events:auto}
      .dsm-detail{padding:16px}.dsm-detail[hidden]{display:none}.dsm-detail-title{font-size:16px;margin:7px 0;color:#e0fbfc;line-height:1.35}
      .dsm-detail-kind{color:#6b9faa;font-size:9px;text-transform:uppercase;letter-spacing:1px}
      .dsm-detail-text{font-size:11px;color:#a3c2c7;line-height:1.7;margin-top:10px}
      .dsm-status{display:inline-block;padding:5px 8px;color:#f8cb80;border:1px solid #5e5944;background:#312a182a;font-size:9px;margin-top:12px}
      .dsm-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:15px}
      .dsm-crosshair{position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);opacity:.35;pointer-events:none}
      .dsm-crosshair:before,.dsm-crosshair:after{content:'';position:absolute;background:#55b6c0}
      .dsm-crosshair:before{width:1px;height:14px;left:6px}.dsm-crosshair:after{height:1px;width:14px;top:6px}
      .dsm-bottom{position:absolute;left:18px;right:18px;bottom:16px;display:flex;align-items:end;justify-content:space-between;gap:12px;font-size:10px}
      .dsm-hint{background:#07161ddd;border:1px solid #254450;padding:11px 13px;color:#8bb4bf;line-height:1.6;max-width:430px}
      .dsm-readout{color:#65b9c6;text-align:right;background:#06131ad9;padding:10px 12px;border:1px solid #1a3745;white-space:nowrap}
      .dsm-short{display:none}
      @media(max-width:900px){.dsm-left{width:208px}.dsm-right{width:240px}.dsm-brand{font-size:11px}.dsm-top{padding:0 10px;gap:7px}.dsm-breadcrumb{display:none}}
      @media(max-width:650px){.dsm-left{top:66px;left:10px;width:198px}.dsm-left .dsm-panel{padding:10px}.dsm-left .dsm-descr,.dsm-left .dsm-legend,.dsm-left .dsm-separator{display:none}.dsm-right{top:auto;bottom:80px;right:10px;width:min(280px,calc(100% - 20px))}.dsm-detail{padding:12px}.dsm-mainlabel{font-size:13px}.dsm-top{height:54px}.dsm-brand small{display:none}.dsm-btn{font-size:9px;padding:5px 7px}.dsm-toolbar .dsm-btn .dsm-long{display:none}.dsm-toolbar .dsm-btn .dsm-short{display:inline}.dsm-bottom{left:10px;right:10px;bottom:10px}.dsm-hint{font-size:9px}.dsm-readout{display:none}}
    `;
    document.head.appendChild(style);
  }

  _createDOM() {
    const root = document.createElement('div');
    root.className = 'dsm';
    if (this.embedded) {
      // Embedded: canvas only. The application shell owns every other surface.
      root.classList.add('dsm--embedded');
      root.innerHTML = `<canvas aria-label="Interactive spatial Dyson swarm map" tabindex="0"></canvas>`;
      this.root = root;
      this.container.appendChild(root);
      this.canvas = root.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.ui = null;
      return;
    }
    root.innerHTML = `
      <canvas aria-label="Interactive spatial Dyson swarm map" tabindex="0"></canvas>
      <div class="dsm-chrome">
        <header class="dsm-top">
          <div class="dsm-brand">HABITAT <span style="color:#5be0c1">05</span><small>SPATIAL OBSERVATION SYSTEM</small></div>
          <div class="dsm-breadcrumb" data-role="breadcrumb">SWARM / CENTRAL OBSERVATION</div>
          <nav class="dsm-toolbar" aria-label="Map controls">
            <button class="dsm-btn" data-act="physical" aria-pressed="true">PHYSICAL</button>
            <button class="dsm-btn" data-act="navigation" aria-pressed="false"><span class="dsm-long">NAVIGATION</span><span class="dsm-short">NAV</span></button>
            <button class="dsm-btn" data-act="influence" aria-pressed="false"><span class="dsm-long">INFLUENCE</span><span class="dsm-short">INF</span></button>
            <button class="dsm-btn" data-act="zoomIn" aria-label="Zoom in">+</button>
            <button class="dsm-btn" data-act="zoomOut" aria-label="Zoom out">−</button>
            <button class="dsm-btn dsm-btn-amber" data-act="home">⌂ <span class="dsm-long">SWARM</span></button>
          </nav>
        </header>
        <aside class="dsm-left"><div class="dsm-panel">
          <div class="dsm-eyebrow">◈ SYSTEM OVERVIEW</div>
          <div class="dsm-mainlabel" data-role="modeTitle">CENTRAL SURVEY</div>
          <div class="dsm-descr" data-role="modeDesc">Sun-centered observation. Distinctive infrastructure remains visible; further information requires discovery.</div>
          <div class="dsm-separator"></div>
          <div class="dsm-statrow"><span>OBSERVED CONTACTS</span><strong data-role="contactCount">—</strong></div>
          <div class="dsm-statrow"><span>AREA</span><strong data-role="areaName">SWARM</strong></div>
          <div class="dsm-separator"></div>
          <div class="dsm-eyebrow" style="margin-bottom:12px">VECTOR KEY</div>
          <div class="dsm-legend"><i class="dsm-swatch" style="color:#4cd8e3"></i> Ancient superstructure</div>
          <div class="dsm-legend"><i class="dsm-swatch" style="color:#d0dce7"></i> Known location</div>
          <div class="dsm-legend"><i class="dsm-swatch" style="color:#5be0b5"></i> Player vicinity</div>
          <div class="dsm-legend"><i class="dsm-swatch" style="color:#858aff"></i> Observed vessel</div>
        </div></aside>
        <aside class="dsm-right" aria-live="polite"><div class="dsm-panel dsm-detail" data-role="detail" hidden>
          <div class="dsm-eyebrow">◈ SELECTED CONTACT</div>
          <div class="dsm-detail-title" data-role="detailName"></div>
          <div class="dsm-detail-kind" data-role="detailKind"></div>
          <div class="dsm-status" data-role="detailStatus"></div>
          <div class="dsm-detail-text" data-role="detailText"></div>
          <div class="dsm-actions" data-role="contactActions"></div>
          <div class="dsm-actions">
            <button class="dsm-btn" data-act="inspect">FOCUS</button>
            <button class="dsm-btn" data-act="local">LOCAL VIEW →</button>
            <button class="dsm-btn" data-act="clear">DISMISS</button>
          </div>
        </div></aside>
        <div class="dsm-crosshair"></div>
        <footer class="dsm-bottom">
          <div class="dsm-hint" data-role="hint">DRAG TO LOOK AROUND · SCROLL TO ZOOM · SELECT A CONTACT</div>
          <div class="dsm-readout" data-role="readout">AZ 000.0° / EL 00.0°</div>
        </footer>
      </div>`;
    this.root = root;
    this.container.appendChild(root);
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.ui = Object.fromEntries(['breadcrumb','modeTitle','modeDesc','contactCount','areaName','detail','detailName','detailKind','detailStatus','detailText','contactActions','readout','hint'].map(k=>[k,root.querySelector(`[data-role="${k}"]`)]));
  }

  _bindEvents() {
    this._listeners = [];
    const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);this._listeners.push(()=>target.removeEventListener(type,handler,options));};
    listen(this.root,'click',e=>{
      if(!this.interactive)return;
      const contactButton=e.target.closest('button[data-contact-action]');
      if(contactButton&&!contactButton.disabled&&this.selectedId){
        this.actionCallback({entityId:this.selectedId,actionId:contactButton.dataset.contactAction});
        return;
      }
      const b=e.target.closest('button[data-act]');if(!b)return;
      const a=b.dataset.act;
      if(['physical','navigation','influence'].includes(a))this.setOverlay(a);
      else if(a==='zoomIn')this.zoom(1);
      else if(a==='zoomOut')this.zoom(-1);
      else if(a==='home')this.returnToSwarm();
      else if(a==='inspect'&&this.selectedId)this.inspect(this.selectedId);
      else if(a==='local'&&this.selectedId)this.enterLocal(this.selectedId);
      else if(a==='clear')this.select(null);
    });
    listen(this.canvas,'pointerdown',e=>{
      if(!this.interactive)return;
      this.canvas.setPointerCapture(e.pointerId);
      this.pointer={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};
    });
    listen(this.canvas,'pointermove',e=>{
      if(!this.interactive)return;
      if(this.pointer&&this.pointer.id===e.pointerId){
        const dx=e.clientX-this.pointer.x,dy=e.clientY-this.pointer.y;
        this.pointer.x=e.clientX;this.pointer.y=e.clientY;
        if(Math.hypot(e.clientX-this.pointer.startX,e.clientY-this.pointer.startY)>5)this.pointer.moved=true;
        if(this.pointer.moved){
          this.targetCamera.yaw-=dx*this.options.sensitivity;
          this.targetCamera.pitch=Math.max(-1.42,Math.min(1.42,this.targetCamera.pitch+dy*this.options.sensitivity));
          if(this.mode==='local')this._positionLocalCamera();
        }
      }else{const p=this._mouse(e);this.hoverId=this._pick(p.x,p.y);this.canvas.style.cursor=this.hoverId?'pointer':'grab';}
    });
    listen(this.canvas,'pointerup',e=>{
      if(!this.interactive)return;
      if(!this.pointer||this.pointer.id!==e.pointerId)return;
      if(!this.pointer.moved){const p=this._mouse(e);this.select(this._pick(p.x,p.y));}
      this.pointer=null;
    });
    listen(this.canvas,'pointercancel',()=>{this.pointer=null;});
    listen(this.canvas,'wheel',e=>{if(!this.interactive)return;e.preventDefault();this.zoom(e.deltaY<0?1:-1);},{passive:false});
    listen(this.canvas,'dblclick',e=>{if(!this.interactive)return;const p=this._mouse(e),id=this._pick(p.x,p.y);if(id){this.select(id);this.enterLocal(id);}});
    listen(this.canvas,'keydown',e=>{
      // Never intercept Tab: keyboard users must always be able to leave the canvas.
      if(!this.interactive||e.key==='Tab')return;
      if(e.key==='Escape'){this.select(null);return;}
      if(e.key==='+'||e.key==='=')this.zoom(1);
      if(e.key==='-')this.zoom(-1);
      if(e.key==='ArrowLeft')this.targetCamera.yaw+=.12;
      if(e.key==='ArrowRight')this.targetCamera.yaw-=.12;
      if(e.key==='ArrowUp')this.targetCamera.pitch=Math.min(1.42,this.targetCamera.pitch+.10);
      if(e.key==='ArrowDown')this.targetCamera.pitch=Math.max(-1.42,this.targetCamera.pitch-.10);
      if(e.key.toLowerCase()==='h')this.returnToSwarm();
    });
    if(typeof ResizeObserver!=='undefined'){
      this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.container);
    }else{listen(window,'resize',()=>this.resize());}
  }

  // CSS zoom on an ancestor (the shell's UI scale): pointer and bounding-box values are in screen px,
  // while w/h and drawing use the canvas's own (zoomed) px.
  _cssZoom(){return this.canvas.currentCSSZoom||1;}
  _mouse(e){const r=this.canvas.getBoundingClientRect(),z=this._cssZoom();return{x:(e.clientX-r.left)/z,y:(e.clientY-r.top)/z};}
  resize(){if(this.disposed)return;this.w=Math.max(1,this.root.clientWidth);this.h=Math.max(1,this.root.clientHeight);this.pixelRatio=Math.min(2,window.devicePixelRatio||1)*this._cssZoom();this.canvas.width=Math.round(this.w*this.pixelRatio);this.canvas.height=Math.round(this.h*this.pixelRatio);this.ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);if(typeof this.options.localCameraDistance==='function'&&this.mode==='local')this._positionLocalCamera();}
  setWorld(world={}) {
    this.world={ entities:[],routes:[],playerLocationId:null,...world };
    this.entities=new Map(this.world.entities.map(e=>[e.id,{...e,position:{...(e.position||{x:0,y:0,z:0})}}]));
    if(this.selectedId&&!this.entities.has(this.selectedId))this.selectedId=null;
    this._refreshUI();
  }
  updateEntity(id,patch) {
    const prev=this.entities.get(id);if(!prev)return false;
    this.entities.set(id,{...prev,...patch,position:patch.position?{...patch.position}:prev.position});
    if(this.selectedId===id)this._refreshUI();
    return true;
  }
  select(id,{notify=true}={}) {
    this.selectedId=id&&this.entities.has(id)?id:null;
    this._refreshUI();
    if(!notify)return;
    const obj=this.selectedId?this.entities.get(this.selectedId):null;
    // Pass IDs and explicitly displayable fields only, never raw simulation entities.
    this.selectionCallback(obj?{id:obj.id,type:obj.type,visibility:obj.visibility||'identified'}:null);
  }
  setOverlay(mode){if(!this.options.overlays.includes(mode))return;this.overlay=mode;this._refreshUI();}
  zoom(direction){
    // Zooming toward a selected contact naturally crosses into the local tier.
    // The character does NOT move: only the inspection camera changes.
    if(direction>0&&this.mode!=='local'&&this.selectedId&&this.targetCamera.fov<=25){
      this.enterLocal(this.selectedId);return;
    }
    if(direction<0&&this.mode==='local'&&this.targetCamera.fov>=73){
      this.returnToSwarm();return;
    }
    const range=this.mode==='local'?[17,75]:[18,83];
    this.targetCamera.fov=Math.max(range[0],Math.min(range[1],this.targetCamera.fov+(direction>0?-7:7)));
  }
  inspect(id) {
    const e=this.entities.get(id);if(!e)return;
    this.select(id);
    const p=e.position;
    const d=Math.hypot(p.x,p.y,p.z)||1;
    // Temporary translation toward the inspected entity; not physical player travel.
    this.mode='inspect';this.localAreaId=null;
    this.targetCamera={x:p.x*.27,y:p.y*.27,z:p.z*.27,
      yaw:Math.atan2(p.x,p.z),pitch:Math.asin(p.y/d),fov:34};
    this._refreshUI();this.viewCallback({mode:'inspect',focusId:id});
  }
  enterLocal(id) {
    const e=this.entities.get(id);if(!e)return;
    const site=e.areaId?(this.entities.get(e.areaId)||e):e;
    if(!site)return;
    this.select(id);
    this.mode='local';this.localAreaId=site.id;
    this.targetCamera.yaw=0.37;this.targetCamera.pitch=-0.42;this.targetCamera.fov=51;
    this._positionLocalCamera();
    this._refreshUI();this.viewCallback({mode:'local',focusId:site.id});
  }
  _positionLocalCamera(){
    const site=this.entities.get(this.localAreaId);if(!site)return;
    const d=this.options.localCameraDistance,p=site.position,dist=typeof d==='function'?d(this.w,this.h):d;
    const y=this.targetCamera.yaw, t=this.targetCamera.pitch;
    const f={x:Math.sin(y)*Math.cos(t),y:Math.sin(t),z:Math.cos(y)*Math.cos(t)};
    this.targetCamera.x=p.x-f.x*dist;this.targetCamera.y=p.y-f.y*dist;this.targetCamera.z=p.z-f.z*dist;
  }
  returnToSwarm(){
    const focus=this.entities.get(this.localAreaId||this.selectedId);
    this.mode='swarm';this.localAreaId=null;
    const p=focus?.position,dist=p?Math.hypot(p.x,p.y,p.z):0;
    this.targetCamera={...this.targetCamera,x:0,y:0,z:0,fov:64,
      yaw:dist?Math.atan2(p.x,p.z):this.targetCamera.yaw,
      pitch:dist?Math.asin(p.y/dist):this.targetCamera.pitch};
    this._refreshUI();this.viewCallback({mode:'swarm',focusId:null});
  }
  /** Read-only camera/view summary for the host shell. */
  getView(){
    const c=this.camera;
    return {mode:this.mode,focusId:this.mode==='local'?this.localAreaId:this.mode==='inspect'?this.selectedId:null,
      selectedId:this.selectedId,overlay:this.overlay,yaw:c.yaw,pitch:c.pitch,fov:c.fov,interactive:this.interactive};
  }
  /** Ids eligible for display in the current view mode (on-screen or not). */
  viewIds(){
    const localSite=this.mode==='local'?this.entities.get(this.localAreaId):null;
    return [...this.entities.values()].filter(e=>e.type==='megastructure'||this._eligible(e,localSite)).map(e=>e.id);
  }
  /** Ids drawn on screen in the last rendered frame. */
  visibleIds(){return [...this._screen.keys()];}
  /** CSS-pixel position (relative to the map root) of an entity in the last frame, or null. */
  screenPositionOf(id){const p=this._screen.get(id);return p?{x:p.x,y:p.y}:null;}
  /** Suspend/restore pointer and keyboard input (e.g. while a modal scene is open). Rendering continues. */
  setInteractive(on){
    this.interactive=!!on;
    if(!this.interactive){this.pointer=null;this.hoverId=null;this.canvas.style.cursor='default';}
    else this.canvas.style.cursor='grab';
    this.canvas.tabIndex=this.interactive?0:-1;
    this.canvas.setAttribute('aria-disabled',String(!this.interactive));
  }
  _eligible(e,localSite){
    if(this.mode==='swarm'&&e.type==='ship')return false;
    if(this.mode==='swarm'&&e.areaId&&!e.authored)return false;
    if(localSite&&e.areaId&&e.areaId!==localSite.id&&e.id!==localSite.id)return false;
    if(localSite&&!e.areaId&&e.id!==localSite.id&&e.type!=='ship'){
      const d=Math.hypot(e.position.x-localSite.position.x,e.position.y-localSite.position.y,e.position.z-localSite.position.z);
      if(d>this.options.localRadius)return false;
    }
    return true;
  }
  /** Display label: host-supplied label wins; never falls back to the (possibly meaningful) id. */
  _label(e){
    if(e.label)return e.label;
    if(e.visibility==='signal')return 'UNKNOWN STRUCTURE';
    return e.name||TYPE_WORD[e.type]||'CONTACT';
  }
  _refreshUI(){
    if(!this.ui)return;
    const e=this.selectedId?this.entities.get(this.selectedId):null;
    const localSite=this.mode==='local'?this.entities.get(this.localAreaId):null;
    const count=[...this.entities.values()].filter(o=>{
      if(this.mode==='swarm'||this.mode==='inspect')return o.type!=='ship'&&(!o.areaId||o.authored);
      if(!localSite)return true;
      if(o.areaId)return o.areaId===localSite.id;
      const p=o.position,q=localSite.position;
      return o.id===localSite.id||Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<this.options.localRadius;
    }).length;
    this.ui.contactCount.textContent=String(count).padStart(2,'0');
    this.ui.areaName.textContent=this.localAreaId?(this.entities.get(this.localAreaId)?.name||'LOCAL'):'SWARM';
    const titles={swarm:'CENTRAL SURVEY',inspect:'FOCUSED OBSERVATION',local:'LOCAL SPACE'};
    const messages={
      swarm:'Fixed stellar-origin observation. Massive structures remain identifiable by silhouette; detailed knowledge must be earned.',
      inspect:'Virtual inspection camera is translated along the selected direction. The character has not traveled.',
      local:'Area-centered observation. Nearby vessels are shown using positions supplied by the simulation.'
    };
    this.ui.modeTitle.textContent=titles[this.mode];this.ui.modeDesc.textContent=messages[this.mode];
    this.ui.breadcrumb.textContent=this.mode==='swarm'?'SWARM / CENTRAL OBSERVATION':this.mode==='inspect'?'SWARM / FOCUSED INSPECTION':`SWARM / ${this.ui.areaName.textContent.toUpperCase()}`;
    this.ui.hint.textContent=this.mode==='local'?'DRAG TO ROTATE AREA · SELECT OBJECTS · HOME TO SWARM': 'DRAG TO LOOK AROUND · SCROLL TO ZOOM · SELECT A CONTACT';
    for(const m of ['physical','navigation','influence'])this.root.querySelector(`[data-act="${m}"]`).setAttribute('aria-pressed',String(this.overlay===m));
    this.ui.detail.hidden=!e;
    if(e){
      const visibility=e.visibility||'identified';
      this.ui.detailName.textContent=visibility==='signal'?(e.type==='megastructure'?'UNCLASSIFIED MEGASTRUCTURE':'UNIDENTIFIED CONTACT'):(e.label||e.name||TYPE_WORD[e.type]||'CONTACT');
      this.ui.detailKind.textContent=e.type.toUpperCase()+(e.authored?' · LANDMARK':'');
      this.ui.detailStatus.textContent=visibility==='signal'?'SIGNATURE ONLY':visibility==='identified'?'IDENTIFIED':'SURVEY DATA AVAILABLE';
      this.ui.detailText.textContent=visibility==='signal'?'An anomalous structure has been detected. Its purpose, condition, and history are not yet known.':(e.detail||'No additional records available for this location.');
      this.ui.contactActions.replaceChildren();
      for(const action of e.actions||[]){
        const btn=document.createElement('button');btn.className='dsm-btn';
        btn.textContent=action.label;btn.dataset.contactAction=action.id;
        btn.disabled=action.enabled===false;
        this.ui.contactActions.appendChild(btn);
      }
    }
  }

  _projection(position){return projectPoint(this.camera,position,this.w,this.h);}
  _visible(p,pad=80){return p&&p.x>-pad&&p.x<this.w+pad&&p.y>-pad&&p.y<this.h+pad;}
  _line(a,b,color,width=1,dash=[]){
    const p=this._projection(a),q=this._projection(b);
    if(!p||!q)return;
    const c=this.ctx;c.beginPath();c.strokeStyle=color;c.lineWidth=width;c.setLineDash(dash);
    c.moveTo(p.x,p.y);c.lineTo(q.x,q.y);c.stroke();c.setLineDash([]);
  }
  _spherical(az,el,r){return DysonSwarmCentralMap.spherical(az,el,r);}
  _background(){
    const c=this.ctx,w=this.w,h=this.h;
    const grad=c.createRadialGradient(w*.53,h*.47,20,w*.53,h*.47,Math.max(w,h)*.8);
    grad.addColorStop(0,'#0b1b23');grad.addColorStop(.55,'#061018');grad.addColorStop(1,'#03080e');
    c.fillStyle=grad;c.fillRect(0,0,w,h);
    // Deliberately fixed, very subtle instrumentation texture.
    for(let i=0;i<90;i++){
      const x=((i*73.9+Math.sin(i*21)*23)%w+w)%w, y=((i*47.2+Math.cos(i*11)*47)%h+h)%h;
      c.fillStyle=i%7===0?'#37606b6d':'#36546240';c.fillRect(x,y,i%5===0?2:1,i%5===0?2:1);
    }
    c.fillStyle='rgba(9,21,26,.10)';for(let y=0;y<h;y+=5)c.fillRect(0,y,w,1);
    // Soft central bearing, never a blazing grid.
    const midX=w*.5,midY=h*.5;
    c.strokeStyle='#2b66702b';c.lineWidth=1;c.beginPath();c.arc(midX,midY,Math.min(w,h)*.28,0,Math.PI*2);c.stroke();
  }
  _drawSun(){
    // Fades in on entering Local View; hidden at once on leaving, since the camera then flies toward the star.
    if(this._sunAlpha<.01)return;
    const d=sunDisc(this.camera,this.mode,this.w,this.h);if(!d)return;
    const c=this.ctx,{x,y,r}=d,t=this.time;
    c.save();c.globalAlpha=this._sunAlpha;
    const cr=r*SUN.corona*(1+Math.sin(t*.6)*.04);
    let g=c.createRadialGradient(x,y,r*.9,x,y,cr);
    g.addColorStop(0,'#f3bd6538');g.addColorStop(.35,'#f3bd6514');g.addColorStop(1,'#f3bd6500');
    c.fillStyle=g;c.beginPath();c.arc(x,y,cr,0,Math.PI*2);c.fill();
    g=c.createRadialGradient(x-r*.2,y-r*.2,r*.1,x,y,r);
    g.addColorStop(0,'#fff4d6');g.addColorStop(.6,'#ffd27a');g.addColorStop(1,'#f39a3c');
    c.fillStyle=g;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();
    c.restore();
  }
  _grid(){
    if(this.mode==='local'){
      const site=this.entities.get(this.localAreaId);if(!site)return;
      const p=site.position, c=this.ctx;
      for(let i=-8;i<=8;i++){
        const d=i*15;
        this._line({x:p.x+d,y:p.y-65,z:p.z-120},{x:p.x+d,y:p.y-65,z:p.z+120},'#31717f2b',.8);
        this._line({x:p.x-120,y:p.y-65,z:p.z+d},{x:p.x+120,y:p.y-65,z:p.z+d},'#31717f2b',.8);
      }
      return;
    }
    if(this.mode==='inspect')return;
    for(let az=-180;az<180;az+=15){
      for(let el=-60;el<60;el+=8)this._line(this._spherical(az,el,830),this._spherical(az,el+8,830),az%45===0?'#3c899335':'#2f74811c',.8);
    }
    for(let el=-60;el<=60;el+=15){
      for(let az=-180;az<180;az+=6)this._line(this._spherical(az,el,830),this._spherical(az+6,el,830),el===0?'#498d9940':'#34708025',.8);
    }
  }
  _drawMegastructure(e){
    const s=e.structure;if(!s)return;
    const ctx=this.ctx;
    const bands=5, polygons=[];
    const edgeA=s.elevation,edgeB=s.elevation+s.height;
    // Angular and radial ribs give the giant structure physical presence rather than a territory fill.
    for(const {azA,azB,panelStart,panelEnd} of structureCells(s)){
      const pts=[this._spherical(azA,edgeA,s.radius),this._spherical(azB,edgeA,s.radius),this._spherical(azB,edgeB,s.radius),this._spherical(azA,edgeB,s.radius)].map(p=>this._projection(p));
      if(pts.every(Boolean)){
        ctx.beginPath();pts.forEach((p,j)=>j?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();
        ctx.fillStyle=e.colorFill||'#16576528';ctx.fill();ctx.lineWidth=.8;ctx.strokeStyle='#55c5d04c';ctx.stroke();
        polygons.push(pts);
        for(let b=1;b<bands;b++){
          const v=b/bands;
          this._line(this._spherical(azA,edgeA+s.height*v,s.radius),this._spherical(azB,edgeA+s.height*v,s.radius),'#62cfd039',.55);
        }
        // Heavy ribs frame each panel at both ends, so every panel reads alike.
        if(panelStart)this._line(this._spherical(azA,edgeA,s.radius),this._spherical(azA,edgeB,s.radius),'#85e3e6a0',1.6);
        if(panelEnd)this._line(this._spherical(azB,edgeA,s.radius),this._spherical(azB,edgeB,s.radius),'#85e3e6a0',1.6);
      }
    }
    for(const poly of polygons)this.hits.push({type:'polygon',id:e.id,points:poly});
    if(polygons.length){const q=polygons[Math.floor(polygons.length/2)];this._screen.set(e.id,{x:(q[0].x+q[2].x)/2,y:(q[0].y+q[2].y)/2});}
    // Marker can be selected even if the long shape spans beyond the viewport.
    const mid=this._spherical((s.azStart+s.azEnd)*.5,s.elevation+s.height*.5,s.radius);
    const point=this._projection(mid);
    if(this._visible(point))this._drawMarker(point,e,'megastructure');
  }
  _drawRoutes(){
    if(this.overlay!=='navigation')return;
    const ctx=this.ctx;
    for(const route of this.world.routes||[]){
      const a=this.entities.get(route.from),b=this.entities.get(route.to);if(!a||!b)continue;
      this._line(a.position,b.position,route.color||'#7cc1a75b',1.5,[4,7]);
    }
  }
  _drawInfluence(){
    if(this.overlay!=='influence')return;
    const ctx=this.ctx;
    const areas=(this.world.influence||[]);
    for(const area of areas){
      const p=this._projection(area.center);if(!this._visible(p))continue;
      const scale=Math.min(170,Math.max(25,(area.size||38)*p.scale));
      const grad=ctx.createRadialGradient(p.x,p.y,4,p.x,p.y,scale);
      const color=area.color||'#668eb6';
      grad.addColorStop(0,color+'45');grad.addColorStop(1,color+'00');
      ctx.fillStyle=grad;ctx.beginPath();ctx.arc(p.x,p.y,scale,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle=color+'65';ctx.lineWidth=1;ctx.setLineDash([3,5]);ctx.stroke();ctx.setLineDash([]);
    }
  }
  _drawMarker(p,e,kind){
    const ctx=this.ctx;
    const isSelected=e.id===this.selectedId,isHovered=e.id===this.hoverId;
    const local=this.mode==='local';
    const col=e.color||({ship:'#858aff',asteroid:'#87919c',station:'#d3e9f4',factory:'#deb877',wreck:'#9f9eae',megastructure:'#53d9e7'}[kind]||'#b3c7cb');
    const x=p.x,y=p.y;
    const size=kind==='megastructure'?7:kind==='ship'?(local?9:6):kind==='asteroid'?(local?Math.max(4,Math.min(15,(e.scale||2.5)*p.scale)):3.5):local?10:7;
    if(!this._visible(p,35))return;
    const stale=!!e.presentation?.stale;
    ctx.save();
    if(stale)ctx.globalAlpha=.5;
    if(isSelected||isHovered){ctx.beginPath();ctx.arc(x,y,size+11,0,Math.PI*2);ctx.strokeStyle=isSelected?'#6cebd9b0':'#aac9d878';ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);}
    ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=1.6;
    if(kind==='ship'){
      // A world-space unit `direction` (embedded game) is projected to a screen angle; `heading` is a raw screen angle.
      let direction=e.direction?screenHeading(p,this._projection({x:e.position.x+e.direction.x,y:e.position.y+e.direction.y,z:e.position.z+e.direction.z}),e.heading||0):(e.heading||0);
      ctx.translate(x,y);ctx.rotate(direction);ctx.beginPath();ctx.moveTo(0,-size-3);ctx.lineTo(size*.8,size);ctx.lineTo(0,size*.35);ctx.lineTo(-size*.8,size);ctx.closePath();
      // Last-known (stale) contacts are drawn as a dashed ghost outline, never as a live solid glyph.
      if(stale){ctx.setLineDash([3,3]);ctx.strokeStyle=col;ctx.stroke();ctx.setLineDash([]);}else{ctx.fillStyle='#e9f1ff';ctx.fill();ctx.strokeStyle=col;ctx.stroke();}
      ctx.translate(-x,-y);
    }else if(kind==='station'||kind==='factory'){
      ctx.beginPath();ctx.rect(x-size*.7,y-size*.7,size*1.4,size*1.4);ctx.fillStyle='#071620';ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.arc(x,y,size+4,0,Math.PI*2);ctx.strokeStyle=col+'77';ctx.stroke();
      ctx.fillStyle=col;ctx.fillRect(x-1.3,y-1.3,2.6,2.6);
    }else if(kind==='asteroid'||kind==='wreck'){
      ctx.beginPath();for(let j=0;j<7;j++){const a=j*Math.PI*2/7,r=size*(.85+.15*Math.sin(j*17));j?ctx.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r):ctx.moveTo(x+Math.cos(a)*r,y+Math.sin(a)*r);}ctx.closePath();ctx.fillStyle=col+'af';ctx.fill();
    }else {
      ctx.beginPath();ctx.moveTo(x,y-size);ctx.lineTo(x+size,y);ctx.lineTo(x,y+size);ctx.lineTo(x-size,y);ctx.closePath();ctx.fillStyle='#0b252c';ctx.fill();ctx.stroke();
    }
    if(e.id===this.world.playerLocationId){
      ctx.beginPath();ctx.arc(x,y,size+9+Math.sin(this.time*1.8)*1.1,0,Math.PI*2);ctx.strokeStyle='#45e5af88';ctx.lineWidth=1.5;ctx.stroke();
    }
    if(stale&&kind!=='ship'){ctx.beginPath();ctx.arc(x,y,size+5,0,Math.PI*2);ctx.setLineDash([2,4]);ctx.strokeStyle=col;ctx.stroke();ctx.setLineDash([]);}
    ctx.restore();
    this.hits.push({type:'circle',id:e.id,x,y,r:Math.max(15,size+9)});
    this._screen.set(e.id,{x,y});
    if((e.authored||isSelected||local&&kind!=='asteroid')&&(kind!=='ship'||e.label&&(isSelected||stale))){
      const age=stale&&e.presentation.ageText?` · ${e.presentation.ageText}`:'';
      const label=String(this._label(e)).toUpperCase()+age;
      const fs=10;ctx.font=`${fs}px monospace`;
      // Keep labels out of host-declared panel areas (standalone default reserves the right detail panel).
      const ins=this.options.labelInsets||(this.embedded?{}:{right:290});
      const maxX=this.w-(ins.right||0);
      if((x<maxX||this.w<700)&&x>(ins.left||0)&&y>(ins.top||0)&&y<this.h-(ins.bottom||0)){
        const tx=x+size+12,ty=y+4;
        ctx.fillStyle='#07151bdc';ctx.fillRect(tx-4,ty-12,Math.min(196,ctx.measureText(label).width+11),18);
        ctx.fillStyle=e.id===this.selectedId?'#b7fff2':e.visibility==='signal'?'#81b5bd':'#abcdd6';ctx.fillText(label,tx,ty,193);
      }
    }
  }
  _drawEntities(){
    const items=[];
    const localSite=this.mode==='local'?this.entities.get(this.localAreaId):null;
    for(const e of this.entities.values()){
      if(e.type==='megastructure'||!this._eligible(e,localSite))continue;
      const p=this._projection(e.position);
      if(this._visible(p,25))items.push({e,p});
    }
    items.sort((a,b)=>b.p.z-a.p.z);
    for(const {e,p} of items)this._drawMarker(p,e,e.type);
  }
  _pointInPolygon(x,y,points){let c=false;for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)c=!c;
  }return c;}
  _pick(x,y){for(let i=this.hits.length-1;i>=0;i--){const h=this.hits[i];if(h.type==='circle'&&Math.hypot(h.x-x,h.y-y)<h.r)return h.id;if(h.type==='polygon'&&this._pointInPolygon(x,y,h.points))return h.id;}return null;}
  _draw(){
    if(this.disposed)return;
    const ctx=this.ctx;ctx.clearRect(0,0,this.w,this.h);this.hits=[];this._screen=new Map();
    this._background();this._drawSun();this._grid();this._drawInfluence();
    for(const e of this.entities.values())if(e.type==='megastructure')this._drawMegastructure(e);
    this._drawRoutes();this._drawEntities();
    const az=((this.camera.yaw*180/Math.PI)%360+360)%360;
    const el=this.camera.pitch*180/Math.PI;
    if(this.ui)this.ui.readout.textContent=`AZ ${az.toFixed(1)}°  /  EL ${el>=0?'+':''}${el.toFixed(1)}°  ·  ${this.overlay.toUpperCase()}`;
  }
  _tick(time){
    if(this.disposed||!this.running)return;
    const dt=Math.min(.06,Math.max(0,(time-this._lastTime)/1000));this._lastTime=time;this.time+=dt;
    for(const key of ['x','y','z','yaw','pitch','fov']){
      const t=this.targetCamera[key],c=this.camera[key];
      this.camera[key]=c+(t-c)*Math.min(1,dt*7.5);
    }
    this._sunAlpha=this.mode==='local'?this._sunAlpha+(1-this._sunAlpha)*Math.min(1,dt*4):0;
    this._draw();
    this._frame=requestAnimationFrame(t=>this._tick(t));
  }
  /** Stops the render loop entirely (no RAF scheduled) until resume(). */
  pause(){this.running=false;cancelAnimationFrame(this._frame);this._frame=null;}
  resume(){if(this.disposed||this.running)return;this.running=true;this._lastTime=performance.now();this._frame=requestAnimationFrame(t=>this._tick(t));}
  destroy(){
    if(this.disposed)return;this.disposed=true;this.running=false;cancelAnimationFrame(this._frame);this._frame=null;
    if(this.resizeObserver)this.resizeObserver.disconnect();
    for(const off of this._listeners)off();this._listeners=[];
    this.root.remove();this.entities.clear();
  }
}
