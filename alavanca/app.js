(async () => {
  'use strict';
  const parts=['app.part1','app.part2','app.part3','app.part4','app.part5','app.part6'];
  try{
    const chunks=[];
    for(const path of parts){
      const response=await fetch(path);
      if(!response.ok) throw new Error('Falha ao carregar '+path);
      chunks.push((await response.text()).trim());
    }
    const binary=atob(chunks.join(''));
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const code=new TextDecoder('utf-8').decode(bytes);
    (0,eval)(code);
  }catch(error){
    console.error('Falha ao iniciar Alavanca Dinâmica:',error);
    const box=document.createElement('div');
    box.style.cssText='margin:24px;padding:16px;border:1px solid #ff6d75;border-radius:14px;background:#241014;color:#fff;font-family:system-ui';
    box.textContent='Não foi possível iniciar o aplicativo. Recarregue a página com internet e tente novamente.';
    document.body.prepend(box);
  }
})();
