'use strict';
// Only reader-facing provenance belongs in public responses, never editorial IDs or instructions.
function synthesisMeta(value) {
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{return null;}}
 if(!value||typeof value!=='object')return null;
 const result={};
 for(const key of ['source_count','source_names','timespan_hours','word_count','deep_dive','cluster_count'])if(value[key]!==undefined)result[key]=value[key];
 return result;
}
const fields = new Set(('id title slug summary category source source_url image_url published_at created_at updated_at is_featured featured_priority featured_until generated_title topic_tag content_type full_content content_blocks source_article_ids writer_id writer_name writer_slug writer_avatar_url writer_color writer_bio writer_beats writer_beat audio_url audio_status audio_transcript audio_voice_name audio_voice_avatar_url media_enabled embed_url embed_type source_type inline_images disable_summary tldr_overview tldr_context pull_quote followups final_thoughts comment_count reaction_count share_count hot_score effective_importance perspective_count perspectives tracking_count published_slug').split(' '));
function article(value){
 const result={};for(const key of fields)if(value[key]!==undefined)result[key]=value[key];
 if(value.synthesis_meta)result.synthesis_meta=synthesisMeta(value.synthesis_meta);
 return result;
}
module.exports={synthesisMeta,article};
