import handler from "./api-handler.cjs";
export default { async fetch(request) {
 const url=new URL(request.url), headers=Object.fromEntries(request.headers.entries()); let body;
 if(!["GET","HEAD"].includes(request.method)){const raw=await request.text();if(raw){try{body=JSON.parse(raw)}catch{return new Response(JSON.stringify({error:"bad_json"}),{status:400,headers:{"content-type":"application/json"}})}}}
 const req={method:request.method,url:request.url,headers,body}, hs=new Headers();let status=200,output="";
 const res={setHeader(n,v){hs.set(n,Array.isArray(v)?v.join(", "):String(v))},getHeader(n){return hs.get(n)},end(v=""){output=v==null?"":String(v)}};
 Object.defineProperty(res,"statusCode",{get(){return status},set(v){status=v}});
 try{await handler(req,res,url.pathname);if(!hs.has("content-type"))hs.set("content-type","application/json; charset=utf-8");return new Response(output,{status,headers:hs})}
 catch(e){console.error("Nettle API error",e);return new Response(JSON.stringify({error:"internal_error"}),{status:500,headers:{"content-type":"application/json; charset=utf-8"}})}
}};
