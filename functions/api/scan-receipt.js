export async function onRequestPost(context) {
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) {
        return new Response(JSON.stringify({ 
            error: "ยังไม่ได้ตั้งค่าคีย์ระบบสแกนรูปภาพ AI (GEMINI_API_KEY) ใน Environment Variables ของโครงการ Cloudflare Pages กรุณาไปที่หน้าจัดการของ Cloudflare แล้วเพิ่มตัวแปรก่อนใช้งานครับ" 
        }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
        });
    }

    try {
        const { image, mimeType } = await context.request.json();
        if (!image || !mimeType) {
            return new Response(JSON.stringify({ error: "Missing image base64 data or mimeType" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Gemini API multimodal instruction prompt
        const prompt = `วิเคราะห์รูปภาพใบเสร็จ ใบเสนอราคา หรือใบแจ้งหนี้ต่อไปนี้ และทำการสกัดข้อมูลประเภทค่าใช้จ่ายออกมาให้อยู่ในรูปแบบ JSON ตามโครงสร้างวัตถุดังนี้:
        {
          "item": "ชื่อรายการสินค้า บริการ หรือชื่องานหลักสั้นๆ (ภาษาไทย)",
          "description": "คำอธิบายรายละเอียด เช่น ขนาด ยี่ห้อ หรือจำนวนเฉพาะเจาะจงเพิ่มเติม (ถ้ามี)",
          "date": "วันที่จ่ายหรือออกเอกสาร รูปแบบ YYYY-MM-DD เท่านั้น (หากปีบนเอกสารเป็น พ.ศ. ให้แปลงเป็นปี ค.ศ. คริสต์ศักราชให้ถูกต้อง เช่น 2569 -> 2026, 2568 -> 2025)",
          "location": "ชื่อสถานที่ โซน หรือพื้นที่หน้างานที่นำไปใช้สั้นๆ เช่น ออฟฟิศ, คอกไก่, งานรั้ว, สวน, ห้องน้ำ (ระบุตามที่เดาได้จากเอกสาร หรือเว้นว่างหากไม่มี)",
          "category": "หมวดหมู่งานหลัก เช่น งานเทพื้น, งานระบบไฟฟ้า, งานฉาบผนัง, งานประปา, งานปูน (เว้นว่างหากไม่แน่ใจ)",
          "pic": "ชื่อร้านค้า บริษัท แพลตฟอร์ม หรือชื่อช่างผู้รับเงิน เช่น 79 วัสดุก่อสร้าง, Shopee, ไทวัสดุ, ดูโฮม, ช่าง-อาสิทธิ์",
          "number": ตัวเลขจำนวน/ปริมาณสิ่งของ (ตัวเลขจำนวนเต็มหรือทศนิยมเท่านั้น เช่น 2.5),
          "unit": "หน่วยนับของปริมาณ เช่น ชิ้น, วัน, คิว, ก้อน, ถุง",
          "priceUnit": ราคาต่อหน่วยของสินค้า/บริการ (เป็นตัวเลขเท่านั้น),
          "total": ราคารวมสุทธิของรายการนี้ (เป็นตัวเลขยอดรวมเงินสดหรือรวมภาษีแล้วในใบเสร็จ)",
          "type": "ประเภทของค่าใช้จ่าย โดยจำแนกให้ตรงกับข้อใดข้อหนึ่งใน 3 ข้อนี้เท่านั้น: 'ค่าวัสดุ/อุปกรณ์', 'ค่าแรง', หรือ 'ค่าขนส่ง'"
        }

        ให้ตรวจสอบความสัมพันธ์ของราคาให้ถูกต้อง: total = number * priceUnit (หากในใบเสร็จไม่มี ให้คำนวณและสรุปให้สมเหตุสมผล)
        ให้ตอบเป็น JSON ที่ถูกต้องเพียงอย่างเดียวตาม generationConfig`;

        // Request payload for Gemini Beta Multimodal endpoint
        const requestPayload = {
            contents: [
                {
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: image
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        const modelsToTry = [
            "gemini-1.5-flash",
            "gemini-2.0-flash-exp",
            "gemini-1.5-pro"
        ];

        let geminiResponse = null;
        let lastErrorText = "";

        for (const modelName of modelsToTry) {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const resp = await fetch(geminiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestPayload)
            });

            if (resp.ok) {
                geminiResponse = resp;
                break;
            } else {
                lastErrorText = await resp.text();
                console.warn(`Model ${modelName} returned error: ${lastErrorText}`);
            }
        }

        if (!geminiResponse) {
            throw new Error(`Gemini API error: ${lastErrorText}`);
        }

        const result = await geminiResponse.json();
        
        // Extract raw JSON text from Gemini output parts
        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            throw new Error("Gemini AI failed to return valid analysis text.");
        }

        // Parse to verify it is valid JSON
        const parsedData = JSON.parse(responseText.trim());
        
        return new Response(JSON.stringify(parsedData), {
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });

    } catch (err) {
        console.error("Gemini server error:", err);
        return new Response(JSON.stringify({ 
            error: "เกิดข้อผิดพลาดในการประมวลผลรูปภาพจาก AI: " + err.message 
        }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
