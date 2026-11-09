pub struct Holder {
    pub data: Box<i32>,
    pub ptr: *const i32,
}

impl Holder {
    pub fn new(val: i32) -> Self {
        let data = Box::new(val);
        let ptr = &*data as *const i32;
        Self { data, ptr }
    }

    pub fn replace_box(&mut self, new_val: i32) {
        // BUG: replaces Box without updating raw pointer ptr, causing dangling pointer!
        self.data = Box::new(new_val);
    }

    pub fn read_via_ptr(&self) -> i32 {
        unsafe { *self.ptr }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_replace_and_move() {
        let mut h = Holder::new(10);
        assert_eq!(h.read_via_ptr(), 10);
        h.replace_box(99);
        let h_moved = Box::new(h);
        assert_eq!(h_moved.read_via_ptr(), 99);
    }
}
