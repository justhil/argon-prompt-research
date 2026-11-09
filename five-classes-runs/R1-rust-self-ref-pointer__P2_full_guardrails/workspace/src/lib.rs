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

    pub fn add(&mut self, delta: i32) {
        *self.data += delta;
        self.ptr = &*self.data as *const i32;
    }

    pub fn replace_box(&mut self, new_val: i32) {
        self.data = Box::new(new_val);
        self.ptr = &*self.data as *const i32;
    }

    pub fn read_via_ptr(&self) -> i32 {
        unsafe { *self.ptr }
    }

    pub fn read_value(&self) -> i32 {
        self.read_via_ptr()
    }
}
