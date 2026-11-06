// Rewrites the H.264 SPS so the decoder does NOT hold back pictures for reordering.
//
// Background: without the VUI field `max_num_reorder_frames` the Windows decoder assumes the worst case
// and holds back up to `max_num_ref_frames` pictures before it outputs one. That is noticeable delay.
// The iPhone stream has no B-frames, so we write `num_reorder_frames = 0`.
//
// H.264 stores numbers as "Exp-Golomb" codes (ue/se): small numbers need few bits.

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize, // position in bits
}

impl BitReader<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.pos / 8)?;
        let b = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(b as u32)
    }
    fn bits(&mut self, n: u32) -> Option<u32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Some(v)
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
    fn se(&mut self) -> Option<i32> {
        let k = self.ue()?;
        Some(if k % 2 == 1 {
            k.div_ceil(2) as i32
        } else {
            -((k / 2) as i32)
        })
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        self.pos += n;
        (self.pos <= self.data.len() * 8).then_some(())
    }
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    nbits: usize,
}

impl BitWriter {
    fn bit(&mut self, b: u32) {
        if self.nbits % 8 == 0 {
            self.bytes.push(0);
        }
        if b != 0 {
            *self.bytes.last_mut().unwrap() |= 0x80 >> (self.nbits % 8);
        }
        self.nbits += 1;
    }
    fn ue(&mut self, v: u32) {
        let x = v + 1;
        let len = 32 - x.leading_zeros(); // number of bits in x
        for _ in 0..len - 1 {
            self.bit(0);
        }
        for i in (0..len).rev() {
            self.bit((x >> i) & 1);
        }
    }
}

/// Removes the "emulation prevention" bytes (00 00 03 -> 00 00).
fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// Re-inserts emulation prevention bytes: after 00 00 no byte <= 3 may follow.
fn escape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 4);
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

fn skip_scaling_list(r: &mut BitReader, size: u32) -> Option<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            next = (last + r.se()? + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Some(())
}

fn skip_hrd(r: &mut BitReader) -> Option<()> {
    let cpb_cnt = r.ue()? + 1;
    r.skip(8)?; // bit_rate_scale + cpb_size_scale
    for _ in 0..cpb_cnt {
        r.ue()?;
        r.ue()?;
        r.bit()?;
    }
    r.skip(20) // 4 x 5 bit length fields
}

/// Takes an SPS (NAL unit WITHOUT start code, including the header byte) and returns a variant with
/// `num_reorder_frames = 0`. `None` if the SPS could not be read (then use the original).
pub fn low_latency(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 5 || nal[0] & 0x1f != 7 {
        return None;
    }
    let rbsp = unescape(&nal[1..]);
    let mut r = BitReader {
        data: &rbsp,
        pos: 0,
    };

    let profile = r.bits(8)?;
    r.skip(16)?; // constraint flags + level_idc
    r.ue()?; // seq_parameter_set_id
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
        let chroma_format = r.ue()?;
        if chroma_format == 3 {
            r.bit()?;
        }
        r.ue()?; // bit_depth_luma
        r.ue()?; // bit_depth_chroma
        r.bit()?; // qpprime_y_zero_transform_bypass
        if r.bit()? == 1 {
            for i in 0..(if chroma_format != 3 { 8 } else { 12 }) {
                if r.bit()? == 1 {
                    skip_scaling_list(&mut r, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.ue()?; // log2_max_frame_num_minus4
    match r.ue()? {
        0 => {
            r.ue()?; // log2_max_pic_order_cnt_lsb_minus4
        }
        1 => {
            r.bit()?;
            r.se()?;
            r.se()?;
            for _ in 0..r.ue()? {
                r.se()?;
            }
        }
        _ => {}
    }
    let max_num_ref_frames = r.ue()?;
    r.bit()?; // gaps_in_frame_num_value_allowed_flag
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    if r.bit()? == 0 {
        r.bit()?; // mb_adaptive_frame_field_flag
    }
    r.bit()?; // direct_8x8_inference_flag
    if r.bit()? == 1 {
        for _ in 0..4 {
            r.ue()?; // frame_crop_*_offset
        }
    }

    // From here on VUI. `restriction_pos` = bit position from which we rewrite everything.
    let restriction_pos;
    let vui_pos = r.pos;
    let mut add_empty_vui = false;
    if r.bit()? == 1 {
        if r.bit()? == 1 {
            // aspect_ratio_info
            if r.bits(8)? == 255 {
                r.skip(32)?;
            }
        }
        if r.bit()? == 1 {
            r.bit()?; // overscan_info
        }
        if r.bit()? == 1 {
            // video_signal_type
            r.skip(4)?;
            if r.bit()? == 1 {
                r.skip(24)?;
            }
        }
        if r.bit()? == 1 {
            r.ue()?; // chroma_loc_info
            r.ue()?;
        }
        if r.bit()? == 1 {
            r.skip(65)?; // timing_info
        }
        let nal_hrd = r.bit()? == 1;
        if nal_hrd {
            skip_hrd(&mut r)?;
        }
        let vcl_hrd = r.bit()? == 1;
        if vcl_hrd {
            skip_hrd(&mut r)?;
        }
        if nal_hrd || vcl_hrd {
            r.bit()?; // low_delay_hrd_flag
        }
        r.bit()?; // pic_struct_present_flag
        restriction_pos = r.pos; // bitstream_restriction_flag is here
    } else {
        restriction_pos = vui_pos;
        add_empty_vui = true;
    }

    // Rebuild: copy everything up to restriction_pos, then our values, then the closing bits.
    let mut src = BitReader {
        data: &rbsp,
        pos: 0,
    };
    let mut w = BitWriter::default();
    for _ in 0..restriction_pos {
        w.bit(src.bit()?);
    }
    if add_empty_vui {
        w.bit(1); // vui_parameters_present_flag
        for _ in 0..8 {
            w.bit(0); // aspect, overscan, video_signal, chroma_loc, timing, nal_hrd, vcl_hrd, pic_struct: all absent
        }
    }
    w.bit(1); // bitstream_restriction_flag
    w.bit(1); // motion_vectors_over_pic_boundaries_flag
    w.ue(2); // max_bytes_per_pic_denom
    w.ue(1); // max_bits_per_mb_denom
    w.ue(16); // log2_max_mv_length_horizontal
    w.ue(16); // log2_max_mv_length_vertical
    w.ue(0); // max_num_reorder_frames = 0  <-- the decisive value
    w.ue(max_num_ref_frames.max(1)); // max_dec_frame_buffering
    w.bit(1); // rbsp_stop_one_bit
    while w.nbits % 8 != 0 {
        w.bit(0);
    }

    let mut out = vec![nal[0]];
    out.extend(escape(&w.bytes));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real SPS from an iPhone (High Profile, Level 3.1, VUI without bitstream_restriction).
    const IPHONE_SPS: [u8; 18] = [
        0x27, 0x64, 0x00, 0x1f, 0xac, 0x13, 0x14, 0x50, 0x20, 0x02, 0x27, 0x88, 0x96, 0x6e, 0x02,
        0x1a, 0x02, 0x04,
    ];

    #[test]
    fn exp_golomb_roundtrip() {
        for v in [0u32, 1, 2, 3, 4, 7, 8, 100, 255, 1000, 65535] {
            let mut w = BitWriter::default();
            w.ue(v);
            let mut r = BitReader {
                data: &w.bytes,
                pos: 0,
            };
            assert_eq!(r.ue(), Some(v), "ue({v})");
        }
    }

    #[test]
    fn signed_exp_golomb() {
        // se(v): 0, 1, -1, 2, -2 are stored as ue 0, 1, 2, 3, 4
        for (coded, expected) in [(0u32, 0i32), (1, 1), (2, -1), (3, 2), (4, -2)] {
            let mut w = BitWriter::default();
            w.ue(coded);
            let mut r = BitReader {
                data: &w.bytes,
                pos: 0,
            };
            assert_eq!(r.se(), Some(expected));
        }
    }

    #[test]
    fn emulation_prevention_roundtrip() {
        let raw = [0u8, 0, 1, 0, 0, 0, 0, 3, 0, 0, 2, 7];
        assert_eq!(unescape(&escape(&raw)), raw);
        // 00 00 01 must not occur in the stream, so a 03 has to be inserted
        assert_eq!(escape(&[0, 0, 1]), [0, 0, 3, 1]);
    }

    #[test]
    fn iphone_sps_gets_zero_reorder_frames() {
        let out = low_latency(&IPHONE_SPS).expect("SPS must be parsable");
        assert_eq!(out.len(), 22);
        assert_eq!(
            out[..4],
            IPHONE_SPS[..4],
            "NAL header, profile and level stay untouched"
        );
    }

    #[test]
    fn rewriting_twice_gives_the_same_result() {
        let once = low_latency(&IPHONE_SPS).unwrap();
        assert_eq!(low_latency(&once).unwrap(), once);
    }

    #[test]
    fn non_sps_and_garbage_are_rejected() {
        assert!(
            low_latency(&[0x65, 1, 2, 3, 4, 5]).is_none(),
            "not an SPS NAL"
        );
        assert!(low_latency(&[0x27, 0x64]).is_none(), "too short");
        assert!(
            low_latency(&[0x27, 0x64, 0x00, 0x1f, 0xff]).is_none(),
            "truncated"
        );
    }
}
