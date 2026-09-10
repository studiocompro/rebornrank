(() => {
  const cfg=window.SITE_CONFIG||{}; const locales=window.I18N||{};
  // SEO URLs use the production domain configured in config.js.
  (function injectSeoLinks(){
    if(!cfg.siteUrl) return;
    const base=String(cfg.siteUrl).replace(/\/$/,'');
    const parts=location.pathname.split('/').filter(Boolean);
    const known=['fr','en','es','pt','de','it','ja','ko','zh'];
    const hasLocale=parts.length && known.includes(parts[0]);
    const rest=(hasLocale?parts.slice(1):parts).join('/');
    const currentLocale=hasLocale?parts[0]:'fr';
    const path=hasLocale?('/'+currentLocale+'/'+rest):location.pathname;
    const suffix=(/\/detail\.html$/.test(location.pathname) && new URLSearchParams(location.search).get('id'))?('?id='+encodeURIComponent(new URLSearchParams(location.search).get('id'))):'';
    const canonicalHref=base+(path.endsWith('/')||rest?path:(path+'/'))+suffix;
    let canonical=document.querySelector('link[rel="canonical"]');
    if(!canonical){canonical=document.createElement('link');canonical.rel='canonical';document.head.appendChild(canonical)}
    canonical.href=canonicalHref;
    let og=document.querySelector('meta[property="og:url"]');
    if(!og){og=document.createElement('meta');og.setAttribute('property','og:url');document.head.appendChild(og)}
    og.content=canonicalHref;
    if(hasLocale){
      known.forEach(lang=>{
        const href=base+'/'+lang+'/'+rest+(suffix||'');
        let alt=document.querySelector('link[rel="alternate"][hreflang="'+lang+'"]');
        if(!alt){alt=document.createElement('link');alt.rel='alternate';alt.hreflang=lang;document.head.appendChild(alt)}
        alt.href=href;
      });
      let xd=document.querySelector('link[rel="alternate"][hreflang="x-default"]');
      if(!xd){xd=document.createElement('link');xd.rel='alternate';xd.hreflang='x-default';document.head.appendChild(xd)}
      xd.href=base+'/fr/'+rest+(suffix||'');
    }
  })();
  const body=document.body; const locale=body.dataset.locale||'fr'; const t=locales[locale]||locales.en||{};
  const q=(s,r=document)=>r.querySelector(s); const qa=(s,r=document)=>[...r.querySelectorAll(s)];
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const strip=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/\n+/g,' ');
  const norm=s=>strip(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const flag=c=>({JP:'🇯🇵',KR:'🇰🇷',CN:'🇨🇳',TW:'🇹🇼'}[c]||'🌍');
  const langPrefix=()=>`/${locale}/`;
  window.rr={locale,t,esc,strip,flag};

  const menu=q('#hamb'); if(menu) menu.addEventListener('click',()=>q('#navlinks')?.classList.toggle('open'));
  const lang=q('#language'); if(lang){lang.value=locale; lang.addEventListener('change',e=>{const path=location.pathname.split('/').filter(Boolean); if(path.length&&locales[path[0]]) path.shift(); location.href='/' + e.target.value + '/' + path.join('/') + location.search;});}
  qa('[data-kofi]').forEach(a=>a.href=cfg.koFiUrl||'#');
  qa('[data-fs]').forEach(a=>{if(cfg.forgottenSourceUrl){a.href=cfg.forgottenSourceUrl}else{a.href='#';a.classList.add('disabled');a.addEventListener('click',e=>e.preventDefault())}});
  qa('[data-share]').forEach(b=>b.addEventListener('click',async()=>{const data={title:document.title,url:location.href};try{if(navigator.share)await navigator.share(data);else{await navigator.clipboard.writeText(location.href);b.textContent='✓'}}catch(e){}}));
  const search=q('#globalSearch'); if(search){search.addEventListener('keydown',e=>{if(e.key==='Enter'&&search.value.trim())location.href=`${langPrefix()}decouvrir.html?q=${encodeURIComponent(search.value.trim())}`});}
  q('#randomBtn')?.addEventListener('click',()=>{const cats=window.CATEGORIES||[]; const c=cats[Math.floor(Math.random()*cats.length)]; location.href=`${langPrefix()}classements/${c.slug}.html?sort=TRENDING_DESC`});

  // Persistent side ads. Real AdSense blocks are mounted only when slot IDs are configured.
  const adScript=()=>{if(document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]'))return; const s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.dataset.rrAds='1';s.src=`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${cfg.adsenseClient}`;document.head.appendChild(s)};
  function mountAd(el,key){const slot=cfg.adSlots?.[key]; if(!slot){el.innerHTML='<span>Publicité<br>emplacement réservé</span>'; return;} adScript(); el.innerHTML=`<ins class="adsbygoogle" style="display:block;width:100%;height:100%" data-ad-client="${esc(cfg.adsenseClient)}" data-ad-slot="${esc(slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`; setTimeout(()=>{try{(adsbygoogle=window.adsbygoogle||[]).push({})}catch(e){}},50)}
  qa('[data-ad]').forEach(el=>mountAd(el,el.dataset.ad));

  let lastRequestAt=0;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function gql(query,variables,cacheKey){
    const key='rr:'+cacheKey+':v12'; const ttl=(cfg.cacheHours||12)*3600e3;
    let stale=null;
    try{
      const hit=JSON.parse(localStorage.getItem(key)||'null');
      if(hit){stale=hit.data;if(Date.now()-hit.ts<ttl)return hit.data;}
    }catch(e){}

    // AniList is temporarily limited to 30 requests/minute. Space requests out
    // and reuse cache aggressively instead of bursting several calls at once.
    const gap=2100;
    const wait=Math.max(0,gap-(Date.now()-lastRequestAt));
    if(wait) await sleep(wait);
    lastRequestAt=Date.now();

    let tries=0;
    while(tries<3){
      let r;
      try{
        r=await fetch('/api/anilist',{
          method:'POST',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify({query,variables})
        });
      }catch(err){
        // AniList 429 responses can surface as a generic CORS/network error in browsers.
        tries++;
        if(tries<3){await sleep(2500*tries);continue;}
        if(stale)return stale;
        throw err;
      }

      if(r.status===429){
        tries++;
        const retry=Math.max(2,Number(r.headers.get('Retry-After')||5));
        if(tries<3){await sleep(Math.min(15000,retry*1000));continue;}
        if(stale)return stale;
        throw new Error('API rate limit');
      }
      if(!r.ok){if(stale)return stale;throw new Error('API '+r.status);}
      const j=await r.json();
      if(j.errors){if(stale)return stale;throw new Error(j.errors[0]?.message||'GraphQL');}
      try{localStorage.setItem(key,JSON.stringify({ts:Date.now(),data:j.data}))}catch(e){}
      return j.data;
    }
    if(stale)return stale;
    throw new Error('API unavailable');
  }

  // List queries are intentionally leaner than detail queries: this keeps multi-tag ranking scans responsive.
  const listFields=`id type format status description(asHtml:false) countryOfOrigin averageScore popularity trending favourites startDate{year} title{romaji english native} coverImage{extraLarge large color} tags{name rank isMediaSpoiler isGeneralSpoiler}`;
  const detailFields=`id type format status description(asHtml:false) episodes chapters volumes countryOfOrigin averageScore popularity trending favourites title{romaji english native} coverImage{extraLarge large color} genres tags{name rank isMediaSpoiler isGeneralSpoiler} externalLinks{site url type} bannerImage startDate{year month day}`;
  const byId=`query($id:Int!){Media(id:$id){${detailFields}}}`;

  function countryList(v){if(!v)return null;if(v==='CHINESE')return ['CN','TW'];return [v]}
  function formatList(type,v){if(type==='ANIME')return null;if(v==='NOVEL')return ['NOVEL'];if(v==='COMICS'||!v)return ['MANGA','ONE_SHOT'];return null}

  // AniList's tag_in filter requires all supplied tags. For discovery categories we need OR candidates,
  // then our own precise rule. We therefore query each seed tag as a GraphQL alias in ONE HTTP request
  // and merge the aliases client-side. This finds obscure works without multiplying request count.
  function unionQuery(tagCount){
    const defs=Array.from({length:tagCount},(_,i)=>`$tag${i}:String`).join(',');
    const pages=Array.from({length:tagCount},(_,i)=>`p${i}:Page(page:$page,perPage:50){pageInfo{hasNextPage currentPage} media(type:$type,countryOfOrigin_in:$countries,tag:$tag${i},status:$status,sort:$sort,format_in:$formats,minimumTagRank:$minTagRank,averageScore_greater:$scoreGt,popularity_lesser:$popLt,isAdult:false){${listFields}}}`).join('\n');
    return `query($page:Int,$type:MediaType,$countries:[CountryCode],$status:MediaStatus,$sort:[MediaSort],$formats:[MediaFormat],$minTagRank:Int,$scoreGt:Int,$popLt:Int${defs?','+defs:''}){${pages}}`;
  }
  async function fetchUnionPage(tags,opt={},page=1){
    const clean=[...new Set((tags||[]).filter(Boolean))].slice(0,8);
    if(!clean.length)return {media:[],hasNextPage:false};
    const variables={page,type:opt.type||'MANGA',countries:countryList(opt.country),status:opt.status||null,sort:opt.sort||['SCORE_DESC','POPULARITY_DESC'],formats:formatList(opt.type||'MANGA',opt.format),minTagRank:cfg.ranking?.minTagRank||18,scoreGt:opt.scoreGt??null,popLt:opt.popLt??null};
    clean.forEach((tag,i)=>variables[`tag${i}`]=tag);
    const data=await gql(unionQuery(clean.length),variables,'union:'+clean.join('|')+':'+JSON.stringify(variables));
    const map=new Map(); let hasNextPage=false;
    clean.forEach((_,i)=>{const pg=data[`p${i}`]; if(!pg)return; hasNextPage=hasNextPage||!!pg.pageInfo?.hasNextPage; (pg.media||[]).forEach(m=>map.set(m.id,m));});
    return {media:[...map.values()],hasNextPage};
  }

  const tagNames=m=>new Set((m.tags||[]).map(x=>x.name));
  function matchesCategory(m,c){
    const tags=tagNames(m);
    if(c.tagGroupsAll && !c.tagGroupsAll.every(group=>group.some(x=>tags.has(x)))) return false;
    const sig=c.signals||{}; const hasTagSignal=(sig.tagsAny||[]).some(x=>tags.has(x));
    const text=norm([m.title?.english,m.title?.romaji,m.title?.native,m.description].filter(Boolean).join(' '));
    const hasKeyword=(sig.keywordsAny||[]).some(k=>text.includes(norm(k)));
    if((sig.tagsAny?.length||sig.keywordsAny?.length) && !(hasTagSignal||hasKeyword)) return false;
    return true;
  }
  const SPECIALTY_TAGS=new Set((window.CATEGORIES||[]).flatMap(c=>[
    ...(c.tags||[]), ...(c.signals?.tagsAny||[]), ...(c.tagGroupsAll||[]).flat()
  ]));
  function isSpecialtyMedia(m){return (m.tags||[]).some(x=>SPECIALTY_TAGS.has(x.name));}

  async function fetchCategorySafe(slug,opt={}){
    const c=(window.CATEGORIES||[]).find(x=>x.slug===slug)||window.CATEGORIES?.[0];
    if(!c)return [];
    const maxPages=Math.min(cfg.ranking?.maxScanPages||4,opt.gems?(cfg.hiddenGem?.scanPages||3):(c.pages||cfg.ranking?.defaultScanPages||2));
    const scoreGt=opt.gems?Math.max(0,(cfg.hiddenGem?.minScore||68)-1):null;
    const popLt=opt.gems?(cfg.hiddenGem?.maxPopularity||15000)+1:null;
    const map=new Map();
    for(let page=1;page<=maxPages;page++){
      let pg;
      try{pg=await fetchUnionPage(c.tags,{...opt,scoreGt,popLt},page)}catch(e){if(page===1)throw e;break;}
      (pg.media||[]).filter(m=>matchesCategory(m,c)).forEach(m=>map.set(m.id,m));
      // Once we have enough valid candidates for a Top 50, stop scanning extra pages.
      if(map.size>=60 || !pg.hasNextPage)break;
    }
    return [...map.values()];
  }


  // Default rankings are mixed: Anime + Manga/Manhwa/Manhua. Visitors can still filter each medium.
  async function fetchCategoryDisplay(slug,opt={}){
    const type=opt.type||'ALL';
    if(type!=='ALL') return fetchCategorySafe(slug,opt);
    const common={...opt}; delete common.type;
    // Keep the default mixed ranking focused on comics + animation; novels have their own filter.
    const mangaFormat=common.format||'COMICS';
    const manga=await fetchCategorySafe(slug,{...common,type:'MANGA',format:mangaFormat});
    const anime=await fetchCategorySafe(slug,{...common,type:'ANIME',format:null});
    const map=new Map(); [...manga,...anime].forEach(m=>map.set(m.id,m));
    return [...map.values()];
  }

  // Fallback source: MyAnimeList via Jikan. Used only if AniList fails in the visitor browser.
  const JIKAN_GENRES={anime:{isekai:62,reincarnation:72,time:78,video:79,villainess:83,urban:82,survival:76,martial:17,school:23,supernatural:37,fantasy:10,game:59},manga:{isekai:62,reincarnation:73,time:79,video:80,villainess:81,urban:83,survival:77,martial:17,school:23,supernatural:37,fantasy:10,game:59}};
  const JIKAN_RULES={
    isekai:{genre:'isekai'},'reverse-isekai':{genre:'isekai',kw:['real world','earth','modern world']},reincarnation:{genre:'reincarnation'},
    regression:{genre:'time',kw:['regress','back in time','return to the past','second chance']},'time-loop':{genre:'time',kw:['time loop','loop','reset','repeated']},'second-life':{genre:'reincarnation'},
    'resurrection-power':{genre:'supernatural',kw:['resurrect','revive','revival','immortal']},'summoned-hero':{genre:'isekai',kw:['summon','transported','another world']},'return-to-earth':{genre:'isekai',kw:['return to earth','back on earth','real world']},
    dungeon:{genre:'fantasy',kw:['dungeon','gate','raid']},'hunter-gates':{genre:'urban',kw:['hunter','gate','awaken','dungeon','raid']},'system-leveling':{genre:'video',kw:['system','level up','leveling','status','stats','player','quest']},
    'tower-climb':{genre:'survival',kw:['tower','floor','climb','spire']},necromancy:{genre:'supernatural',kw:['necromancer','necromancy','undead','skeleton']},cultivation:{genre:'martial',kw:['cultivation','cultivator',' qi ','sect']},
    'martial-arts':{genre:'martial'},'cultivation-regression':{genre:'martial',kw:['regress','reincarnat','back in time','cultivation']},'murim-regression':{genre:'martial',kw:['murim','regress','reincarnat','back in time']},
    'villainess-rebirth':{genre:'villainess'},'transmigration-possession':{genre:'reincarnation',kw:['transmigrat','possess','another body']},'novel-game-transmigration':{genre:'isekai',kw:['novel','game world','otome','character']},
    'monster-reincarnation':{genre:'reincarnation',kw:['monster','slime','spider','goblin','dragon','skeleton','beast','sword']},'noble-reincarnation':{genre:'reincarnation',kw:['noble','duke','duchess','prince','princess','royal','aristocrat']},
    'child-reincarnation':{genre:'reincarnation',kw:['baby','child','infant','little girl','little boy']},kingdom:{genre:'isekai',kw:['kingdom','territory','domain','lord','nation']},'revenge-second-chance':{genre:'reincarnation',kw:['revenge','avenge','betray','second chance']},
    'apocalypse-returner':{genre:'survival',kw:['apocalypse','zombie','regress','return','back in time']},'virtual-world':{genre:'video'},'death-game-isekai':{genre:'game',kw:['death game','survive','game','another world']},
    'demon-rebirth':{genre:'reincarnation',kw:['demon','demon lord','devil','maou']},'magic-rebirth':{genre:'reincarnation',kw:['magic','mage','wizard','sorcer']},'body-swap-rebirth':{genre:'reincarnation',kw:['body','swap','possess']},
    'academy-rebirth':{genre:'school',kw:['reincarnat','regress','second chance','academy','school']}
  };
  let jikanLast=0;
  async function jikanGet(url){const wait=Math.max(0,450-(Date.now()-jikanLast));if(wait)await sleep(wait);jikanLast=Date.now();const r=await fetch(url,{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('Jikan '+r.status);return r.json()}
  function normalizeJikan(x,isAnime){const labels=[...(x.genres||[]),...(x.themes||[]),...(x.demographics||[])];const ty=String(x.type||'').toLowerCase();const country=isAnime?'JP':(ty==='manhwa'?'KR':ty==='manhua'?'CN':'JP');const img=x.images?.webp?.large_image_url||x.images?.jpg?.large_image_url||x.images?.webp?.image_url||x.images?.jpg?.image_url||'';const year=x.year||x.aired?.prop?.from?.year||x.published?.prop?.from?.year||null;return {id:Number(x.mal_id),__source:'jikan',__malUrl:x.url||'',type:isAnime?'ANIME':'MANGA',format:String(x.type||'').toUpperCase().replaceAll(' ','_'),status:x.status||'',description:x.synopsis||'',countryOfOrigin:country,averageScore:x.score?Math.round(Number(x.score)*10):0,popularity:Number(x.members||x.scored_by||0),trending:0,favourites:Number(x.favorites||0),startDate:{year},title:{romaji:x.title||'',english:x.title_english||x.title||'',native:x.title_japanese||x.title||''},coverImage:{extraLarge:img,large:img,color:null},tags:labels.map(z=>({name:z.name,rank:100,isMediaSpoiler:false,isGeneralSpoiler:false}))}}
  function jikanMatches(m,rule){if(!rule?.kw?.length)return true;const hay=norm([m.title?.english,m.title?.romaji,m.title?.native,m.description,(m.tags||[]).map(x=>x.name).join(' ')].join(' '));return rule.kw.some(k=>hay.includes(norm(k)))}
  function jikanUrl(kind,slug,opt,page){const isAnime=kind==='anime',ids=JIKAN_GENRES[kind],rule=JIKAN_RULES[slug]||{genre:'isekai'},p=new URLSearchParams({kind,sfw:'true',page:String(page),limit:'25'}),gid=ids[rule.genre];if(gid)p.set('genres',String(gid));const sort=Array.isArray(opt.sort)?opt.sort[0]:opt.sort;if(sort==='START_DATE_DESC'){p.set('order_by','start_date');p.set('sort','desc')}else if(sort==='POPULARITY_DESC'||sort==='TRENDING_DESC'){p.set('order_by','members');p.set('sort','desc')}else{p.set('order_by','score');p.set('sort','desc')}if(!isAnime){if(opt.format==='NOVEL')p.set('type','lightnovel');else if(opt.country==='KR')p.set('type','manhwa');else if(opt.country==='CHINESE')p.set('type','manhua');else if(opt.country==='JP')p.set('type','manga')}return `/api/jikan?${p}`}
  async function fetchJikanOne(kind,slug,opt={}){const rule=JIKAN_RULES[slug]||{genre:'isekai'};let rows=[];for(let page=1;page<=2;page++){try{const j=await jikanGet(jikanUrl(kind,slug,opt,page));rows.push(...(j.data||[]).map(x=>normalizeJikan(x,kind==='anime')).filter(m=>jikanMatches(m,rule)));if(rows.length>=25||!j.pagination?.has_next_page)break}catch(e){console.warn('Jikan '+kind+' page '+page+' failed',e);if(rows.length)break;throw e}}return rows}
  async function fetchJikanCategory(slug,opt={}){const type=opt.type||'ALL';let rows=[];let ok=false;let lastErr=null;
    // Anime and manga are independent: a temporary MAL/Jikan manga outage must never hide anime.
    if((type==='ALL'||type==='ANIME')&&(!opt.country||opt.country==='JP')){try{rows.push(...await fetchJikanOne('anime',slug,opt));ok=true}catch(e){lastErr=e;console.warn('Jikan anime failed',e)}}
    if(type==='ALL'||type==='MANGA'){try{rows.push(...await fetchJikanOne('manga',slug,opt));ok=true}catch(e){lastErr=e;console.warn('Jikan manga failed',e)}}
    if(!ok)throw lastErr||new Error('Jikan unavailable');
    const map=new Map();rows.forEach(m=>map.set(`${m.type}:${m.id}`,m));return [...map.values()]}
  async function fetchResilientCategory(slug,opt={}){try{const rows=await fetchCategoryDisplay(slug,opt);if(rows.length)return {rows,source:'anilist'};console.warn('AniList returned no rows; trying Jikan')}catch(primary){console.warn('AniList failed, using Jikan',primary)}return {rows:await fetchJikanCategory(slug,opt),source:'jikan'}}

  function displayTitle(m){if(locale==='ja'&&m.countryOfOrigin==='JP')return m.title.native||m.title.romaji; if(locale==='ko'&&m.countryOfOrigin==='KR')return m.title.native||m.title.english||m.title.romaji; if(locale==='zh'&&(m.countryOfOrigin==='CN'||m.countryOfOrigin==='TW'))return m.title.native||m.title.english||m.title.romaji; return m.title.english||m.title.romaji||m.title.native||'—'}
  function sortMedia(arr,sort,gems=false){if(gems){return arr.filter(m=>(m.averageScore||0)>=(cfg.hiddenGem?.minScore||68)&&(m.popularity||0)<=(cfg.hiddenGem?.maxPopularity||15000)).sort((a,b)=>gemScore(b)-gemScore(a))} const key=sort||'SCORE_DESC'; return arr.sort((a,b)=> key==='POPULARITY_DESC'?(b.popularity||0)-(a.popularity||0):key==='TRENDING_DESC'?(b.trending||0)-(a.trending||0):key==='START_DATE_DESC'?(b.startDate?.year||0)-(a.startDate?.year||0):(b.averageScore||0)-(a.averageScore||0))}
  const gemScore=m=>(m.averageScore||0)-Math.log10((m.popularity||0)+10)*5+(m.favourites||0)/5000;
  function mediaKind(m){if(m.type==='ANIME')return `🎬 ${t.anime||'Anime'}`;if(m.countryOfOrigin==='KR')return `📚 ${t.manhwa||'Manhwa'}`;if(m.countryOfOrigin==='CN'||m.countryOfOrigin==='TW')return `📚 ${t.manhua||'Manhua'}`;return `📚 ${t.manga||'Manga'}`}
  function card(m,i){const tags=(m.tags||[]).filter(x=>!x.isMediaSpoiler&&!x.isGeneralSpoiler).sort((a,b)=>(b.rank||0)-(a.rank||0)).slice(0,3); const title=displayTitle(m); const href=m.__source==='jikan'?(m.__malUrl||'#'):`${langPrefix()}fiche.html?id=${m.id}`; const extra=m.__source==='jikan'?' target="_blank" rel="noopener noreferrer"':''; return `<article class="media-card"><a class="card-link" href="${esc(href)}"${extra}><div class="cover-wrap"><img loading="lazy" src="${esc(m.coverImage?.extraLarge||m.coverImage?.large||'')}" alt="${esc(title)}"><span class="rank">#${i+1}</span><span class="origin">${flag(m.countryOfOrigin)}</span></div><div class="media-body"><div class="media-title">${esc(title)}</div><div class="native-title">${esc(m.title.native||m.title.romaji||'')}</div><div class="statline"><span class="score">★ ${m.averageScore||'—'}</span><span>👥 ${Intl.NumberFormat(locale).format(m.popularity||0)}</span></div><div class="tags"><span>${esc(mediaKind(m))}${m.__source==='jikan'?' · MAL/Jikan':''}</span>${tags.map(x=>`<span>${esc(x.name)}</span>`).join('')}</div></div></a></article>`}
  function originalCard(){const o=cfg.originalWork||{}; if(!o.enabled)return ''; const href=o.url||cfg.forgottenSourceUrl||`${langPrefix()}soutenir.html`; const cover=o.coverUrl?`<img loading="lazy" src="${esc(o.coverUrl)}" alt="${esc(o.title||'Forgotten Source')}">`:`<div class="fs-mini-cover"><span>FORGOTTEN</span><strong>SOURCE</strong><small>MANGA</small></div>`; return `<article class="media-card creator-media-card"><a class="card-link" href="${esc(href)}"><div class="cover-wrap">${cover}<span class="rank creator-rank">★</span><span class="origin">FS</span></div><div class="media-body"><div class="creator-label">${esc(t.creator_project||'Creator project')} · ${esc(t.creator_unranked||'Unranked')}</div><div class="media-title">${esc(o.title||'Forgotten Source')}</div><div class="native-title">${esc(t.creator_note||'Original manga in development.')}</div><div class="tags"><span>Manga</span><span>Original</span><span>Source Studio</span></div></div></a></article>`}
  function cardsWithOriginal(arr){const after=Math.max(1,cfg.originalWork?.insertAfter||10); const chunks=arr.map(card); if(cfg.originalWork?.enabled)chunks.splice(Math.min(after,chunks.length),0,originalCard()); const ad='<div class="ad-slot ad-inline ranking-ad" data-ad="inFeed"></div>'; [34,17].forEach(pos=>{if(chunks.length>pos)chunks.splice(pos,0,ad)}); return chunks.join('')}

  async function renderRanking(el){const rp=new URLSearchParams(location.search); const slug=rp.get('theme')||el.dataset.category||'isekai'; const type=rp.get('type')||el.dataset.type||'ALL'; const country=rp.get('country')||el.dataset.country||null; const sort=rp.get('sort')||el.dataset.sort||'SCORE_DESC'; const gems=el.dataset.gems==='1'; const format=rp.get('format')||el.dataset.format||(type==='MANGA'?'COMICS':null); el.innerHTML=`<div class="loading">${esc(t.loading||'Loading…')}</div>`; try{const result=await fetchResilientCategory(slug,{type,country,format,sort:[sort,'POPULARITY_DESC'],gems}); let arr=sortMedia(result.rows,sort,gems).slice(0,50); const note=result.source==='jikan'?`<div class="fineprint" style="grid-column:1/-1">AniList est temporairement indisponible : données de secours MyAnimeList/Jikan.</div>`:''; el.innerHTML=arr.length?note+cardsWithOriginal(arr):note+(cfg.originalWork?.enabled?originalCard():`<div class="empty">${esc(t.no_results||'No results')}</div>`); qa('[data-ad="inFeed"]',el).forEach(x=>mountAd(x,'inFeed'))}catch(e){console.error('Both sources failed',e);el.innerHTML=(cfg.originalWork?.enabled?originalCard():'')+`<div class="error" style="grid-column:1/-1">${esc(t.error||'Error')}<br><small>AniList et MyAnimeList/Jikan sont indisponibles.</small></div>`}}
  qa('[data-ranking]').forEach(renderRanking);

  async function searchMedia(term,opt={}){const query=`query($page:Int,$type:MediaType,$search:String,$countries:[CountryCode],$status:MediaStatus,$sort:[MediaSort],$formats:[MediaFormat]){Page(page:$page,perPage:50){media(type:$type,search:$search,countryOfOrigin_in:$countries,status:$status,sort:$sort,format_in:$formats,isAdult:false){${listFields}}}}`; const variables={page:1,type:opt.type||'MANGA',search:term||null,countries:countryList(opt.country),status:opt.status||null,sort:opt.sort||['POPULARITY_DESC'],formats:formatList(opt.type||'MANGA',opt.format)};const data=(await gql(query,variables,'search:'+JSON.stringify(variables))).Page.media;return data.filter(isSpecialtyMedia)}
  async function searchMediaDisplay(term,opt={}){if((opt.type||'ALL')!=='ALL')return searchMedia(term,opt);const common={...opt};delete common.type;const manga=await searchMedia(term,{...common,type:'MANGA',format:common.format||'COMICS'});const anime=await searchMedia(term,{...common,type:'ANIME',format:null});const map=new Map();[...manga,...anime].forEach(m=>map.set(m.id,m));return [...map.values()]}
  async function renderDiscover(){const out=q('#discoverResults');if(!out)return; const params=new URLSearchParams(location.search); const form=q('#filters'); const field=n=>q(`[name=${n}]`,form); if(params.get('q'))q('#discoverQ').value=params.get('q'); ['type','format','country','theme','sort','status'].forEach(n=>{if(params.get(n)&&field(n))field(n).value=params.get(n)});
    const run=async()=>{out.innerHTML=`<div class="loading">${esc(t.loading)}</div>`;const type=field('type').value,format=field('format')?.value||null,country=field('country').value||null,theme=field('theme').value,sort=field('sort').value,status=field('status').value||null,term=q('#discoverQ').value.trim();try{let arr;if(term){arr=await searchMediaDisplay(term,{type,format,country,status,sort:[sort]})}else{arr=(await fetchResilientCategory(theme,{type,format,country,status,sort:[sort,'POPULARITY_DESC']})).rows}arr=sortMedia(arr,sort,false).slice(0,50);const own=term&&norm(cfg.originalWork?.title||'Forgotten Source').includes(norm(term));if(arr.length)out.innerHTML=cardsWithOriginal(arr);else if(own&&cfg.originalWork?.enabled)out.innerHTML=originalCard();else out.innerHTML=`<div class="empty">${esc(t.no_results)}</div>`}catch(e){console.error(e);out.innerHTML=`<div class="error">${esc(t.error)}</div>`}};
    field('type')?.addEventListener('change',()=>{const f=field('format');if(f)f.disabled=field('type').value==='ANIME'});
    form.addEventListener('submit',e=>{e.preventDefault();const p=new URLSearchParams();['type','format','country','theme','sort','status'].forEach(n=>{const v=field(n)?.value;if(v)p.set(n,v)});const term=q('#discoverQ').value.trim();if(term)p.set('q',term);history.replaceState(null,'','?'+p.toString());run()}); run();}
  renderDiscover();

  async function renderDetail(){const root=q('#detailRoot');if(!root)return;const id=Number(new URLSearchParams(location.search).get('id'));if(!id){root.innerHTML='<div class="error">Missing id</div>';return}root.innerHTML=`<div class="loading">${esc(t.loading)}</div>`;try{const m=(await gql(byId,{id},'media:'+id)).Media;const title=displayTitle(m);document.title=title+' — '+(cfg.brand||'RebornRank');const tags=(m.tags||[]).filter(x=>!x.isMediaSpoiler&&!x.isGeneralSpoiler).sort((a,b)=>(b.rank||0)-(a.rank||0)).slice(0,10);const count=m.type==='ANIME'?`${m.episodes||'—'} ${t.episodes||'episodes'}`:`${m.chapters||'—'} ${t.chapters||'chapters'} · ${m.volumes||'—'} ${t.volumes||'volumes'}`;const ext=(m.externalLinks||[]).filter(x=>['STREAMING','INFO','SOCIAL'].includes(x.type)).slice(0,6);root.innerHTML=`<div class="detail"><div class="detail-cover"><img src="${esc(m.coverImage?.extraLarge||m.coverImage?.large||'')}" alt="${esc(title)}"></div><div><div class="eyebrow">${flag(m.countryOfOrigin)} ${esc(m.format||m.type)}</div><h1>${esc(title)}</h1><div class="native-title">${esc(m.title.native||m.title.romaji||'')}</div><div class="meta-grid"><div class="meta"><small>${esc(t.score)}</small><strong>★ ${m.averageScore||'—'}</strong></div><div class="meta"><small>${esc(t.popular)}</small><strong>${Intl.NumberFormat(locale).format(m.popularity||0)}</strong></div><div class="meta"><small>${esc(t.status)}</small><strong>${esc(m.status||'—')}</strong></div><div class="meta"><small>${esc(m.type==='ANIME'?t.episodes:t.chapters)}</small><strong>${esc(count)}</strong></div></div><div class="tags">${tags.map(x=>`<span>${esc(x.name)} ${x.rank||''}%</span>`).join('')}</div></div><div class="desc">${esc(strip(m.description)||'—')}</div><div class="desc">${ext.map(x=>`<a class="btn ghost" target="_blank" rel="noopener noreferrer" href="${esc(x.url)}">${esc(x.site)}</a>`).join(' ')}</div></div>`}catch(e){root.innerHTML=`<div class="error">${esc(t.error)}</div>`}}
  renderDetail();

  const network=q('#networkGrid'); if(network){network.innerHTML=(cfg.networkSites||[]).map(s=>`<a class="network-card" target="_blank" rel="noopener noreferrer" href="${esc(s.url)}"><strong>${esc(s.name)}</strong><small>${esc(s.descByLocale?.[locale]||s.desc||'')}</small><div class="url">${esc(s.url)}</div></a>`).join('')}
})();