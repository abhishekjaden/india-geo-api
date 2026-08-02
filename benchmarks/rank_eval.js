// Evaluate candidate ranking formulas against labelled expectations.
const {Pool}=require('pg');
const S=require('@indic-transliteration/sanscript');
const {phoneticKey,toLatin}=require('./multilingual');
const pool=new Pool({connectionString:'postgresql://postgres@127.0.0.1:5433/ci_test'});

// Labelled truth: for each query, what SHOULD be rank 1.
const CASES=[
  {q:'कुड्डलोर', want:{level:'district', name:'Cuddalore'}},   // the failing case
  {q:'केरल',     want:{level:'state',    name:'KERALA'}},       // currently works
  {q:'மங்களூர்',  want:{level:'village',  name:'Mangalore'}},    // village-only name
  {q:'Cuddalore',want:{level:'district', name:'Cuddalore'}},
  {q:'Kerala',   want:{level:'state',    name:'KERALA'}},
  {q:'Kudaluru', want:{level:'village',  name:'Kudaluru'}},     // village must still win when it's the exact text
];

const LEVELS=`
  WITH hits AS (
    SELECT 'state' l,4 lr,s.name,NULL::text p,s.phonetic_key pk FROM states s WHERE s.phonetic_key %% $1
    UNION ALL SELECT 'district',3,d.name,st.name,d.phonetic_key FROM districts d JOIN states st ON d.state_id=st.id WHERE d.phonetic_key %% $1
    UNION ALL SELECT 'subdistrict',2,sd.name,d.name,sd.phonetic_key FROM subdistricts sd JOIN districts d ON sd.district_id=d.id WHERE sd.phonetic_key %% $1
    UNION ALL SELECT 'village',1,v.name,sd.name,v.phonetic_key FROM villages v JOIN subdistricts sd ON v.subdistrict_id=sd.id WHERE v.phonetic_key %% $1
  )
  SELECT * FROM (
    SELECT l,name,lr, similarity(pk,$1) ps, (pk=$1) ex, similarity(lower(name),$2) ns FROM hits
  ) scored`;

// Candidate ORDER BY strategies
const STRATS={
  'A current (exact,level,score)': 'ex DESC, lr DESC, ps DESC, ns DESC',
  'B level-weighted product':      '(ps * (1 + lr*0.15)) DESC, ns DESC',
  'C blended phonetic+name+level': '(0.55*ps + 0.30*ns + 0.15*(lr/4.0)) DESC',
  'D name-first then level':       '(0.45*ps + 0.40*ns + 0.15*(lr/4.0)) DESC',
  'E level-weighted w/ name tie':   '(ps*(1 + lr*0.12) + ns*0.35) DESC',
};

(async()=>{
  const results={};
  for(const [name,order] of Object.entries(STRATS)) results[name]={hit:0,detail:[]};
  for(const c of CASES){
    const {latin}=toLatin(c.q);
    const key=phoneticKey(latin);
    const plain=String(latin).normalize('NFD').replace(/[\u0300-\u036f\u0331\u0323\u0324]/g,'').toLowerCase().replace(/[^a-z]/g,'');
    for(const [name,order] of Object.entries(STRATS)){
      const sql=LEVELS.replace(/%%/g,'%')+' ORDER BY '+order+' LIMIT 1';
      const {rows}=await pool.query(sql,[key,plain]);
      const top=rows[0];
      const ok=top && top.l===c.want.level && top.name===c.want.name;
      if(ok) results[name].hit++;
      results[name].detail.push(`${c.q}: ${top?top.l+'/'+top.name:'none'} ${ok?'✓':'✗ want '+c.want.level+'/'+c.want.name}`);
    }
  }
  for(const [name,r] of Object.entries(results)){
    console.log(`\n${name}  →  ${r.hit}/${CASES.length}`);
    r.detail.forEach(d=>console.log('    '+d));
  }
  await pool.end();
})();
